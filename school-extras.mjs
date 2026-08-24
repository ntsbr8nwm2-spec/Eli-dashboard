import { chromium } from "playwright";
import fs from "node:fs/promises";
import crypto from "node:crypto";

const GRADES_URL =
  "https://browardschools.focusschoolsoftware.com/focus/Modules.php?force_package=SIS&modname=Grades/StudentRCGrades.php&details=false";
const FOCUS_PORTAL_URL = "https://browardschools.focusschoolsoftware.com/focus/";
const CLEVER_URL = "https://sso.browardschools.com/";
const CANVAS_CALENDAR = "https://browardschools.instructure.com/calendar";

const USERNAME = process.env.BCPS_USERNAME || "";
const PASSWORD = process.env.BCPS_PASSWORD || "";

const DATA_PATH = "data.json";
const STATE_PATH = "school-state.json";
const DEBUG_PATH = "extras-debug.json";

if (!USERNAME || !PASSWORD) {
  throw new Error("BCPS_USERNAME or BCPS_PASSWORD secret is missing.");
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WEEKDAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const trace = [];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = text => console.log(`[EXTRAS] ${text}`);

function safeURLParts(value) {
  try {
    const u = new URL(value);
    return { host: u.hostname.toLowerCase(), path: u.pathname };
  } catch {
    return { host: "unknown", path: "" };
  }
}

function etParts() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  return {
    year: Number(parts.find(p => p.type === "year")?.value),
    month: Number(parts.find(p => p.type === "month")?.value),
    day: Number(parts.find(p => p.type === "day")?.value)
  };
}

function currentSchoolYear() {
  const p = etParts();
  return p.month >= 7 ? `${p.year}-${p.year + 1}` : `${p.year - 1}-${p.year}`;
}

function cleanCourseName(value) {
  const original = String(value || "").trim();
  const upper = original.toUpperCase();
  if (upper.includes("ANAT PHYSIO")) return "Anatomy";
  if (upper.includes("BIOLOGY 1 HON")) return "Biology";
  if (upper.includes("AICE ENG LANG")) return "English";
  if (upper.includes("GEOMETRY")) return "Geometry";
  if (upper.includes("DIGITAL BUS")) return "Digital Bus";
  if (upper.includes("CHORUS")) return "Chorus";
  if (upper.includes("AP WORLD HIST")) return "World Hist";
  if (upper.includes("STUDY HALL")) return "Study Hall";
  return original;
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function readJSON(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function gotoSafe(page, url, timeout = 18000) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  } catch (error) {
    const text = String(error || "");
    if (!text.includes("ERR_ABORTED") && !text.includes("Navigation interrupted")) {
      throw error;
    }
  }
}

async function snapshot(page, stage) {
  const entry = {
    stage,
    at: new Date().toISOString(),
    page: safeURLParts(page.url()),
    title: await page.title().catch(() => ""),
    frameCount: page.frames().length
  };
  trace.push(entry);
  log(`Snapshot ${stage}: ${entry.page.host}${entry.page.path}`);
}

async function submitSAMLForm(page, fieldName) {
  try {
    return await page.evaluate(field => {
      const input = document.querySelector(`input[name="${field}"]`);
      if (!input?.form) return false;
      setTimeout(() => HTMLFormElement.prototype.submit.call(input.form), 30);
      return true;
    }, fieldName);
  } catch {
    return false;
  }
}

async function openMicrosoftSSO(page) {
  try {
    const result = await page.evaluate(() => {
      const target = [...document.querySelectorAll('a,button,input,[role="button"]')]
        .find(el => String(el.innerText || el.value || el.textContent || "")
          .toLowerCase().includes("sign in with microsoft"));
      if (!target) return { found: false, href: null };
      const anchor = target.closest("a");
      return { found: true, href: target.href || anchor?.href || null };
    });
    if (!result.found) return false;
    if (result.href) {
      await gotoSafe(page, result.href);
      return true;
    }
    return await page.evaluate(() => {
      const target = [...document.querySelectorAll('a,button,input,[role="button"]')]
        .find(el => String(el.innerText || el.value || el.textContent || "")
          .toLowerCase().includes("sign in with microsoft"));
      if (!target) return false;
      target.click();
      return true;
    });
  } catch {
    return false;
  }
}

async function submitMicrosoftUsername(page) {
  try {
    const input = page.locator('#i0116, input[name="loginfmt"]').first();
    if (!(await input.count())) return false;
    await input.fill(USERNAME);
    const button = page.locator("#idSIButton9").first();
    if (!(await button.count())) return false;
    await button.click();
    return true;
  } catch {
    return false;
  }
}

async function submitMicrosoftPassword(page) {
  try {
    const input = page.locator('#i0118, input[name="passwd"]').first();
    if (!(await input.count())) return false;
    await input.fill(PASSWORD);
    const button = page.locator("#idSIButton9").first();
    if (!(await button.count())) return false;
    await button.click();
    return true;
  } catch {
    return false;
  }
}

async function selectMicrosoftAccount(page) {
  try {
    return await page.evaluate(wanted => {
      wanted = String(wanted || "").toLowerCase();
      const elements = [...document.querySelectorAll('div[role="button"],button,a,[tabindex]')];
      const account = elements.find(el =>
        String(el.innerText || el.textContent || "").toLowerCase().includes(wanted)
      );
      if (!account) return false;
      account.click();
      return true;
    }, USERNAME);
  } catch {
    return false;
  }
}

async function acceptStaySignedIn(page) {
  try {
    const button = page.locator("#idSIButton9").first();
    if (!(await button.count())) return false;
    await button.click();
    return true;
  } catch {
    return false;
  }
}

async function pageState(page) {
  try {
    return await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const lower = text.toLowerCase();
      return {
        host: String(location.hostname || "").toLowerCase(),
        focusLogin: lower.includes("sign in with microsoft"),
        microsoftUsername: Boolean(document.querySelector('#i0116, input[name="loginfmt"]')),
        microsoftPassword: Boolean(document.querySelector('#i0118, input[name="passwd"]')),
        samlRequest: Boolean(document.querySelector('input[name="SAMLRequest"]')),
        samlResponse: Boolean(document.querySelector('input[name="SAMLResponse"]')),
        staySignedIn: lower.includes("stay signed in"),
        cleverADButton: lower.includes("log in with active directory"),
        browardAD: Boolean(document.querySelector('#userNameInput, input[name="UserName"], input[name="username"]')) &&
          Boolean(document.querySelector('#passwordInput, input[name="Password"], input[type="password"]')),
        cleverDashboard: String(location.hostname || "").toLowerCase().includes("clever.com") &&
          (lower.includes("favorite resources") || lower.includes("resources") || lower.includes("canvas")),
        canvas: String(location.hostname || "").toLowerCase() === "browardschools.instructure.com"
      };
    });
  } catch {
    return {
      host: "", focusLogin: false, microsoftUsername: false, microsoftPassword: false,
      samlRequest: false, samlResponse: false, staySignedIn: false,
      cleverADButton: false, browardAD: false, cleverDashboard: false, canvas: false
    };
  }
}

async function currentGradeRows(page) {
  const schoolYear = currentSchoolYear();
  for (const frame of page.frames()) {
    try {
      const count = await frame.evaluate(year =>
        [...document.querySelectorAll("tr")].filter(tr =>
          String(tr.innerText || "").includes(year)
        ).length,
      schoolYear);
      if (count > 0) return count;
    } catch {}
  }
  return 0;
}

async function automaticFocusLogin(page) {
  log("Starting Focus auth for extras.");
  await gotoSafe(page, GRADES_URL);
  const deadline = Date.now() + 50000;
  let usernameDone = false;
  let passwordDone = false;
  let accountDone = false;
  let stayDone = false;
  let ssoAttempts = 0;
  let requestAttempts = 0;
  let responseAttempts = 0;

  while (Date.now() < deadline) {
    if (await currentGradeRows(page)) {
      log("Focus authenticated for extras.");
      return true;
    }

    const state = await pageState(page);
    log(`Focus extras auth host: ${state.host}`);

    if (state.focusLogin && ssoAttempts < 4) {
      ssoAttempts++;
      if (await openMicrosoftSSO(page)) {
        await sleep(600);
        continue;
      }
    }

    if (state.samlRequest && requestAttempts < 4) {
      requestAttempts++;
      await submitSAMLForm(page, "SAMLRequest");
      await sleep(700);
      continue;
    }

    if (state.microsoftUsername && !usernameDone) {
      usernameDone = true;
      await submitMicrosoftUsername(page);
      await sleep(900);
      continue;
    }

    if (state.microsoftPassword && !passwordDone) {
      passwordDone = true;
      await submitMicrosoftPassword(page);
      await sleep(900);
      continue;
    }

    if (!accountDone && await selectMicrosoftAccount(page)) {
      accountDone = true;
      await sleep(900);
      continue;
    }

    if (state.staySignedIn && !stayDone) {
      stayDone = true;
      await acceptStaySignedIn(page);
      await sleep(900);
      continue;
    }

    if (state.samlResponse && responseAttempts < 4) {
      responseAttempts++;
      await submitSAMLForm(page, "SAMLResponse");
      await sleep(1500);
      if (await currentGradeRows(page)) return true;
      await gotoSafe(page, GRADES_URL);
      await sleep(1000);
      continue;
    }

    await sleep(450);
  }

  await gotoSafe(page, GRADES_URL).catch(() => {});
  await sleep(1500);
  return (await currentGradeRows(page)) > 0;
}

async function openFocusStudentTab(page, tabName) {
  await gotoSafe(page, FOCUS_PORTAL_URL);
  await sleep(1000);

  for (const frame of page.frames()) {
    try {
      const result = await frame.evaluate(wanted => {
        const visible = el => {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const candidates = [...document.querySelectorAll('a,button,[role="tab"],[role="button"],div,span,li')]
          .filter(el => String(el.innerText || el.textContent || "").trim() === wanted)
          .filter(visible);
        if (!candidates.length) return { found: false, href: null };
        let target = candidates[candidates.length - 1];
        target = target.closest('a,button,[role="tab"],[role="button"]') || target;
        return { found: true, href: target.href || null };
      }, tabName);

      if (!result.found) continue;
      if (result.href) await gotoSafe(page, result.href);
      else {
        await frame.evaluate(wanted => {
          let target = [...document.querySelectorAll('a,button,[role="tab"],[role="button"],div,span,li')]
            .find(el => String(el.innerText || el.textContent || "").trim() === wanted);
          target = target?.closest('a,button,[role="tab"],[role="button"]') || target;
          if (!target) return false;
          target.click();
          return true;
        }, tabName);
      }
      await sleep(1400);
      return true;
    } catch {}
  }
  return false;
}

async function scrapeNews(page) {
  const opened = await openFocusStudentTab(page, "News");
  if (!opened) throw new Error("Focus News tab was not found.");

  const all = [];
  for (const frame of page.frames()) {
    try {
      const items = await frame.evaluate(() => {
        const cleanLines = el => String(el.innerText || "").split("\n")
          .map(v => v.replace(/\s+/g, " ").trim()).filter(Boolean);
        const parseCard = el => {
          const lines = cleanLines(el);
          if (lines.length < 6 || lines.length > 12) return null;
          const gradeIndex = lines.findIndex(v => /^[A-F][+-]?$/.test(v));
          const percentIndex = lines.findIndex(v => /^(?:100|[0-9]{1,2})%$/.test(v));
          const dateIndex = lines.findIndex(v => /^\d{1,2}\/\d{1,2}$/.test(v));
          const timeIndex = lines.findIndex(v => /^\d{1,2}:\d{2}\s*(?:AM|PM)$/i.test(v));
          if ([gradeIndex, percentIndex, dateIndex, timeIndex].some(i => i === -1)) return null;
          const afterTime = lines.slice(timeIndex + 1);
          if (afterTime.length !== 2) return null;
          const item = {
            grade: lines[gradeIndex], percent: lines[percentIndex], date: lines[dateIndex],
            time: lines[timeIndex], title: afterTime[0], course: afterTime[1]
          };
          item.key = [item.date,item.time,item.course,item.title,item.grade,item.percent].join("|").toLowerCase();
          return item;
        };
        const candidates = [];
        for (const el of document.querySelectorAll("div,li,tr,article,section")) {
          const item = parseCard(el);
          if (!item) continue;
          const containsSmaller = [...el.querySelectorAll("div,li,tr,article,section")]
            .some(child => child !== el && parseCard(child) !== null);
          if (!containsSmaller) candidates.push(item);
        }
        const unique = [];
        const keys = new Set();
        for (const item of candidates) {
          if (keys.has(item.key)) continue;
          keys.add(item.key);
          unique.push(item);
        }
        return unique;
      });
      all.push(...items);
    } catch {}
  }

  const unique = [];
  const seen = new Set();
  for (const item of all) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    unique.push(item);
  }
  log(`Focus activity cards parsed: ${unique.length}.`);
  return unique;
}

async function analyzeNews(items) {
  const state = await readJSON(STATE_PATH, {});
  const oldSeen = Array.isArray(state.newsSeenHashes) ? state.newsSeenHashes : [];
  const seen = new Set(oldSeen);
  const firstSync = !state.newsInitialized;
  const withHashes = items.map(item => ({ item, digest: hash(item.key) }));
  const newItems = firstSync ? withHashes : withHashes.filter(x => !seen.has(x.digest));

  const activity = newItems.map(({ item }) => {
    let assignment = item.title;
    let points = "";
    const match = String(item.title || "").match(/^(.*)\s+\(([^()]+)\)$/);
    if (match) {
      assignment = match[1].trim();
      points = match[2].trim();
    }
    let score = `${item.percent} ${item.grade}`;
    if (points) score = `${points} · ${score}`;
    return `${cleanCourseName(item.course)} — ${assignment} · ${score}`;
  });

  const status = firstSync && newItems.length
    ? `First sync (${newItems.length})`
    : newItems.length ? `${newItems.length} new` : "Nothing new";

  const nextSeen = [...new Set([...oldSeen, ...withHashes.map(x => x.digest)])].slice(-1000);
  return {
    success: true,
    status,
    activity,
    nextState: { ...state, newsInitialized: true, newsSeenHashes: nextSeen, updatedAt: new Date().toISOString() },
    currentCount: items.length,
    newCount: newItems.length
  };
}

async function clickActiveDirectory(page) {
  try {
    const result = await page.evaluate(() => {
      const target = [...document.querySelectorAll('a,button,[role="button"]')]
        .find(el => String(el.innerText || el.textContent || "").toLowerCase()
          .includes("log in with active directory"));
      if (!target) return { found: false, href: null };
      return { found: true, href: target.href || target.closest("a")?.href || null };
    });
    if (!result.found) return false;
    if (result.href) await gotoSafe(page, result.href);
    else await page.evaluate(() => {
      const target = [...document.querySelectorAll('a,button,[role="button"]')]
        .find(el => String(el.innerText || el.textContent || "").toLowerCase()
          .includes("log in with active directory"));
      target?.click();
    });
    return true;
  } catch {
    return false;
  }
}

async function submitBrowardAD(page) {
  const shortUser = USERNAME.split("@")[0];
  try {
    const user = page.locator('#userNameInput, input[name="UserName"], input[name="username"]').first();
    const pass = page.locator('#passwordInput, input[name="Password"], input[type="password"]').first();
    if (!(await user.count()) || !(await pass.count())) return false;
    await user.fill(shortUser);
    await pass.fill(PASSWORD);
    const submit = page.locator('#submitButton, button[type="submit"], input[type="submit"]').first();
    if (await submit.count()) await submit.click();
    else await page.evaluate(() => {
      const pass = document.querySelector('#passwordInput, input[name="Password"], input[type="password"]');
      if (pass?.form) HTMLFormElement.prototype.submit.call(pass.form);
    });
    return true;
  } catch {
    return false;
  }
}

async function openCanvasTile(page) {
  try {
    const result = await page.evaluate(() => {
      const clean = value => String(value || "").replace(/\s+/g, " ").trim();
      const lower = value => clean(value).toLowerCase();
      const direct = [...document.querySelectorAll("a[href]")].find(link => {
        const href = lower(link.href);
        return href.includes("browardschools.instructure.com") || href.includes("instructure.com/login/saml");
      });
      if (direct?.href) return { found: true, method: "href-canvas", href: direct.href };

      const isCanvas = el => [el.innerText, el.textContent, el.getAttribute?.("aria-label"),
        el.getAttribute?.("title"), el.getAttribute?.("alt"), el.getAttribute?.("src")]
        .some(value => lower(value).includes("canvas"));
      let candidate = [...document.querySelectorAll("img,a,button,div,span")].find(isCanvas);
      if (!candidate) return { found: false, method: "no-canvas-candidate", href: null };
      let current = candidate;
      for (let i = 0; current && i < 12; i++) {
        if (current.tagName === "A" && current.href) return { found: true, method: "ancestor-link", href: current.href };
        const link = current.querySelector?.("a[href]");
        if (link?.href) return { found: true, method: "card-link", href: link.href };
        current = current.parentElement;
      }
      return { found: false, method: "canvas-found-no-link", href: null };
    });
    log(`Canvas tile lookup: ${JSON.stringify(result)}`);
    if (!result.found || !result.href) return false;
    await gotoSafe(page, result.href);
    return true;
  } catch (error) {
    log(`Canvas tile error: ${String(error)}`);
    return false;
  }
}

async function ensureCanvas(page) {
  log("Opening Broward Clever.");
  await gotoSafe(page, CLEVER_URL).catch(() => {});
  await sleep(1200);
  const deadline = Date.now() + 65000;
  let activeDirectoryClicks = 0;
  let browardLogins = 0;
  let microsoftUserAttempts = 0;
  let microsoftPassAttempts = 0;
  let accountAttempts = 0;
  let samlRequestAttempts = 0;
  let samlResponseAttempts = 0;
  let stayAttempts = 0;
  let canvasAttempts = 0;

  while (Date.now() < deadline) {
    const state = await pageState(page);
    log(`Canvas auth host: ${state.host}`);

    if (state.canvas) {
      await sleep(3500);
      if ((await pageState(page)).canvas) return true;
      continue;
    }

    if (state.cleverDashboard && canvasAttempts < 6) {
      canvasAttempts++;
      if (await openCanvasTile(page)) {
        await sleep(2200);
        continue;
      }
    }

    if (state.cleverADButton && activeDirectoryClicks < 4) {
      activeDirectoryClicks++;
      if (await clickActiveDirectory(page)) {
        await sleep(1000);
        continue;
      }
    }

    if (state.browardAD && browardLogins < 3) {
      browardLogins++;
      if (await submitBrowardAD(page)) {
        await sleep(1600);
        continue;
      }
    }

    if (state.samlRequest && samlRequestAttempts < 4) {
      samlRequestAttempts++;
      await submitSAMLForm(page, "SAMLRequest");
      await sleep(700);
      continue;
    }

    if (state.microsoftUsername && microsoftUserAttempts < 3) {
      microsoftUserAttempts++;
      await submitMicrosoftUsername(page);
      await sleep(900);
      continue;
    }

    if (state.microsoftPassword && microsoftPassAttempts < 3) {
      microsoftPassAttempts++;
      await submitMicrosoftPassword(page);
      await sleep(900);
      continue;
    }

    if (accountAttempts < 3 && await selectMicrosoftAccount(page)) {
      accountAttempts++;
      await sleep(900);
      continue;
    }

    if (state.staySignedIn && stayAttempts < 2) {
      stayAttempts++;
      await acceptStaySignedIn(page);
      await sleep(900);
      continue;
    }

    if (state.samlResponse && samlResponseAttempts < 4) {
      samlResponseAttempts++;
      await submitSAMLForm(page, "SAMLResponse");
      await sleep(1400);
      continue;
    }

    await sleep(450);
  }

  return false;
}

function etTodayKey() {
  const p = etParts();
  return `${p.year}-${String(p.month).padStart(2,"0")}-${String(p.day).padStart(2,"0")}`;
}

async function openCanvasAgenda(page) {
  const agendaURL = `${CANVAS_CALENDAR}#view_name=agenda&view_start=${etTodayKey()}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`Opening Canvas Agenda attempt ${attempt}.`);
    await gotoSafe(page, agendaURL).catch(() => {});
    await sleep(4500);
    const result = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      return {
        canvas: String(location.hostname || "").toLowerCase() === "browardschools.instructure.com",
        agenda: text.includes("Agenda"),
        hasDueItems: /Due\s+\d{1,2}:\d{2}\s*(?:am|pm)/i.test(text)
      };
    }).catch(() => null);
    if (result?.canvas && result?.agenda) return true;
    if (attempt < 3) await sleep(2500);
  }
  return false;
}

function agendaDateKey(monthName, day) {
  const monthIndex = MONTHS.findIndex(m => m.toLowerCase() === String(monthName).toLowerCase());
  if (monthIndex === -1) return null;
  const years = currentSchoolYear().split("-").map(Number);
  const year = monthIndex >= 6 ? years[0] : years[1];
  return `${year}-${String(monthIndex + 1).padStart(2,"0")}-${String(Number(day)).padStart(2,"0")}`;
}

function dayDifferenceKey(futureKey, todayKey) {
  const [fy,fm,fd] = futureKey.split("-").map(Number);
  const [ty,tm,td] = todayKey.split("-").map(Number);
  return Math.round((Date.UTC(fy,fm-1,fd) - Date.UTC(ty,tm-1,td)) / 86400000);
}

function dayLabelForKey(key) {
  const diff = dayDifferenceKey(key, etTodayKey());
  if (diff === 0) return "TODAY";
  if (diff === 1) return "TOMORROW";
  const [y,m,d] = key.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y,m-1,d)).getUTCDay()].toUpperCase();
  return `${weekday} ${MONTHS[m-1].toUpperCase()} ${d}`;
}

function parseCanvasBody(body) {
  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  const lines = String(body || "").split(/\n+/).map(clean).filter(Boolean);
  const dateRegex = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat),\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\b/i;
  const dueRegex = /\bDue\s+(\d{1,2}:\d{2}\s*(?:am|pm))\b/i;
  const statusRegex = /\b(Not Completed|Completed|Submitted|Graded|Missing|Late)\b/i;
  const results = [];
  let currentDate = null;
  let pending = null;

  const parsePending = () => {
    if (!pending) return;
    let text = pending.parts.map(clean).filter(Boolean).join(" ").replace(/\s+/g," ").trim();
    if (!text) { pending = null; return; }
    text = text.replace(/^\s*,\s*/, "");
    let title = "", course = "", status = "";
    const statusMatch = text.match(statusRegex);
    if (statusMatch) {
      status = statusMatch[1];
      const statusIndex = statusMatch.index;
      title = text.slice(0, statusIndex).replace(/\s*,\s*$/, "").trim();
      course = text.slice(statusIndex + statusMatch[0].length).trim().replace(/^Calendar\s+/i, "").trim();
    } else {
      const calendarMatch = text.match(/\s+Calendar\s+/i);
      if (calendarMatch) {
        title = text.slice(0, calendarMatch.index).trim();
        course = text.slice(calendarMatch.index + calendarMatch[0].length).trim();
      } else title = text.trim();
    }
    title = title.replace(/^Assignment\s*,?\s*/i, "").replace(/^Quiz\s*,?\s*/i, "")
      .replace(/^Discussion\s*,?\s*/i, "").trim();
    course = course.replace(/^Calendar\s+/i, "").trim();
    if (!title) { pending = null; return; }
    const statusLower = status.toLowerCase();
    const completed = ["completed","submitted","graded"].includes(statusLower);
    results.push({
      dateLabel: pending.date.raw, month: pending.date.month, day: pending.date.day,
      time: pending.time, title, course, status, completed
    });
    pending = null;
  };

  for (const line of lines) {
    const dateMatch = line.match(dateRegex);
    if (dateMatch) {
      parsePending();
      currentDate = { raw: line, month: dateMatch[2], day: Number(dateMatch[3]) };
      continue;
    }

    const dueMatch = line.match(dueRegex);
    if (dueMatch && currentDate) {
      parsePending();
      const afterDue = line.slice(dueMatch.index + dueMatch[0].length).replace(/^\s*,\s*/, "").trim();
      pending = { date: currentDate, time: dueMatch[1], parts: [] };
      if (afterDue) pending.parts.push(afterDue);
      if (statusRegex.test(afterDue) && /\bCalendar\b/i.test(afterDue)) parsePending();
      continue;
    }

    if (pending) {
      const lower = line.toLowerCase();
      if (["calendar","agenda","week","month","today","global navigation menu","create new event"].includes(lower)) continue;
      pending.parts.push(line);
      const joined = pending.parts.join(" ");
      if (statusRegex.test(joined) && /\bCalendar\b/i.test(joined)) parsePending();
    }
  }
  parsePending();

  const unique = [];
  const seen = new Set();
  for (const item of results) {
    const key = [item.dateLabel,item.time,item.title,item.course,item.status].join("|").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return { lines, items: unique };
}

async function collectCanvas(page) {
  if (!(await ensureCanvas(page))) throw new Error("Canvas authentication timed out.");
  if (!(await openCanvasAgenda(page))) throw new Error("Canvas Agenda did not load.");
  const body = await page.locator("body").innerText().catch(() => "");
  const raw = parseCanvasBody(body);
  log(`Canvas Agenda parsed items: ${raw.items.length}.`);

  const todayKey = etTodayKey();
  const upcoming = [];
  for (const item of raw.items) {
    if (item.completed) continue;
    const dueKey = agendaDateKey(item.month, item.day);
    if (!dueKey) continue;
    const diff = dayDifferenceKey(dueKey, todayKey);
    if (diff < 0 || diff > 7) continue;
    upcoming.push({ ...item, dueKey });
  }
  upcoming.sort((a,b) => a.dueKey.localeCompare(b.dueKey) || String(a.time).localeCompare(String(b.time)));

  return {
    success: true,
    assignments: upcoming.map(item => ({
      day: dayLabelForKey(item.dueKey),
      time: String(item.time || "").trim().replace(/(\d)(am|pm)$/i, "$1 $2").toUpperCase(),
      course: cleanCourseName(item.course),
      title: item.title
    })),
    parsedCount: raw.items.length,
    upcomingCount: upcoming.length
  };
}

async function writeDebug(errors, page, news, canvas) {
  await snapshot(page, "extras-final").catch(() => {});
  const payload = {
    at: new Date().toISOString(),
    errors,
    news: news ? { success: news.success, currentCount: news.currentCount ?? 0, newCount: news.newCount ?? 0 } : null,
    canvas: canvas ? { success: canvas.success, parsedCount: canvas.parsedCount ?? 0, upcomingCount: canvas.upcomingCount ?? 0 } : null,
    trace
  };
  await fs.writeFile(DEBUG_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
const context = await browser.newContext({
  locale: "en-US",
  timezoneId: "America/New_York",
  viewport: { width: 1280, height: 900 }
});
const page = await context.newPage();
const errors = [];
let news = null;
let canvas = null;

try {
  try {
    if (!(await automaticFocusLogin(page))) throw new Error("Focus auth failed for News collector.");
    const items = await scrapeNews(page);
    news = await analyzeNews(items);
    log(`Focus activity current: ${news.currentCount}; new: ${news.newCount}.`);
  } catch (error) {
    errors.push(`Focus activity: ${String(error)}`);
    news = { success: false };
  }

  try {
    canvas = await collectCanvas(page);
    log(`Canvas upcoming assignments: ${canvas.upcomingCount}.`);
  } catch (error) {
    errors.push(`Canvas: ${String(error)}`);
    canvas = { success: false };
  }

  const data = await readJSON(DATA_PATH, null);
  if (!data) throw new Error("data.json could not be read after grade monitor.");

  let changed = false;
  if (news.success) {
    data.activityStatus = news.status;
    data.activity = news.activity;
    changed = true;
  }
  if (canvas.success) {
    data.assignments = canvas.assignments;
    changed = true;
  }

  if (changed) {
    data.updatedAt = new Date().toISOString();
    await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  if (news.success) {
    await fs.writeFile(STATE_PATH, JSON.stringify(news.nextState, null, 2) + "\n", "utf8");
  }

  if (errors.length) {
    await writeDebug(errors, page, news, canvas);
    throw new Error(errors.join(" | "));
  }

  await fs.rm(DEBUG_PATH, { force: true }).catch(() => {});
  log("Focus activity + Canvas extras completed successfully.");
} catch (error) {
  if (!errors.length || !String(error).includes(errors[0] || "")) {
    errors.push(String(error));
  }
  await writeDebug(errors, page, news, canvas).catch(() => {});
  throw error;
} finally {
  await browser.close();
}

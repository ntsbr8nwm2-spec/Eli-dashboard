import { chromium } from "playwright";
import fs from "node:fs/promises";
import crypto from "node:crypto";

const GRADES_URL = "https://browardschools.focusschoolsoftware.com/focus/Modules.php?force_package=SIS&modname=Grades/StudentRCGrades.php&details=false";
const FOCUS_PORTAL_URL = "https://browardschools.focusschoolsoftware.com/focus/";
const USERNAME = process.env.BCPS_USERNAME || "";
const PASSWORD = process.env.BCPS_PASSWORD || "";
const DATA_PATH = "data.json";
const STATE_PATH = "news-state.json";
const DEBUG_PATH = "news-debug.json";

if (!USERNAME || !PASSWORD) throw new Error("BCPS credentials are missing.");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = text => console.log(`[NEWS] ${text}`);
const trace = [];

function currentSchoolYear() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(new Date());
  const year = Number(parts.find(p => p.type === "year")?.value);
  const month = Number(parts.find(p => p.type === "month")?.value);
  return month >= 7 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

function cleanCourseName(value) {
  const original = String(value || "").replace(/\s+/g, " ").trim();
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

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function readJSON(path, fallback) {
  try { return JSON.parse(await fs.readFile(path, "utf8")); }
  catch { return fallback; }
}

async function gotoSafe(page, url, timeout = 18000) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  } catch (error) {
    const text = String(error || "");
    if (!text.includes("ERR_ABORTED") && !text.includes("Navigation interrupted")) throw error;
  }
}

async function submitSAMLForm(page, fieldName) {
  try {
    return await page.evaluate(field => {
      const input = document.querySelector(`input[name="${field}"]`);
      if (!input?.form) return false;
      setTimeout(() => HTMLFormElement.prototype.submit.call(input.form), 30);
      return true;
    }, fieldName);
  } catch { return false; }
}

async function openMicrosoftSSO(page) {
  try {
    const result = await page.evaluate(() => {
      const target = [...document.querySelectorAll('a,button,input,[role="button"]')]
        .find(el => String(el.innerText || el.value || el.textContent || "").toLowerCase().includes("sign in with microsoft"));
      if (!target) return { found: false, href: null };
      return { found: true, href: target.href || target.closest("a")?.href || null };
    });
    if (!result.found) return false;
    if (result.href) await gotoSafe(page, result.href);
    else await page.evaluate(() => {
      const target = [...document.querySelectorAll('a,button,input,[role="button"]')]
        .find(el => String(el.innerText || el.value || el.textContent || "").toLowerCase().includes("sign in with microsoft"));
      target?.click();
    });
    return true;
  } catch { return false; }
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
  } catch { return false; }
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
  } catch { return false; }
}

async function selectMicrosoftAccount(page) {
  try {
    return await page.evaluate(wanted => {
      wanted = String(wanted || "").toLowerCase();
      const target = [...document.querySelectorAll('div[role="button"],button,a,[tabindex]')]
        .find(el => String(el.innerText || el.textContent || "").toLowerCase().includes(wanted));
      if (!target) return false;
      target.click();
      return true;
    }, USERNAME);
  } catch { return false; }
}

async function acceptStaySignedIn(page) {
  try {
    const button = page.locator("#idSIButton9").first();
    if (!(await button.count())) return false;
    await button.click();
    return true;
  } catch { return false; }
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
        staySignedIn: lower.includes("stay signed in")
      };
    });
  } catch {
    return { host: "", focusLogin: false, microsoftUsername: false, microsoftPassword: false, samlRequest: false, samlResponse: false, staySignedIn: false };
  }
}

async function currentGradeRows(page) {
  const schoolYear = currentSchoolYear();
  for (const frame of page.frames()) {
    try {
      const count = await frame.evaluate(year => [...document.querySelectorAll("tr")]
        .filter(tr => String(tr.innerText || "").includes(year)).length, schoolYear);
      if (count > 0) return count;
    } catch {}
  }
  return 0;
}

async function automaticFocusLogin(page) {
  await gotoSafe(page, GRADES_URL);
  const deadline = Date.now() + 50000;
  let usernameDone = false, passwordDone = false, accountDone = false, stayDone = false;
  let ssoAttempts = 0, requestAttempts = 0, responseAttempts = 0;

  while (Date.now() < deadline) {
    if (await currentGradeRows(page)) return true;
    const state = await pageState(page);
    log(`Auth host: ${state.host}`);

    if (state.focusLogin && ssoAttempts < 4) {
      ssoAttempts++;
      if (await openMicrosoftSSO(page)) { await sleep(600); continue; }
    }
    if (state.samlRequest && requestAttempts < 4) {
      requestAttempts++;
      await submitSAMLForm(page, "SAMLRequest"); await sleep(700); continue;
    }
    if (state.microsoftUsername && !usernameDone) {
      usernameDone = true; await submitMicrosoftUsername(page); await sleep(900); continue;
    }
    if (state.microsoftPassword && !passwordDone) {
      passwordDone = true; await submitMicrosoftPassword(page); await sleep(900); continue;
    }
    if (!accountDone && await selectMicrosoftAccount(page)) {
      accountDone = true; await sleep(900); continue;
    }
    if (state.staySignedIn && !stayDone) {
      stayDone = true; await acceptStaySignedIn(page); await sleep(900); continue;
    }
    if (state.samlResponse && responseAttempts < 4) {
      responseAttempts++;
      await submitSAMLForm(page, "SAMLResponse");
      await sleep(1500);
      if (await currentGradeRows(page)) return true;
      await gotoSafe(page, GRADES_URL); await sleep(1000); continue;
    }
    await sleep(450);
  }

  await gotoSafe(page, GRADES_URL).catch(() => {});
  await sleep(1500);
  return (await currentGradeRows(page)) > 0;
}

async function openNewsTab(page) {
  await gotoSafe(page, FOCUS_PORTAL_URL);
  await sleep(1200);

  for (const frame of page.frames()) {
    try {
      const result = await frame.evaluate(() => {
        const visible = el => {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const candidates = [...document.querySelectorAll('a,button,[role="tab"],[role="button"],div,span,li')]
          .filter(el => String(el.innerText || el.textContent || "").trim().toLowerCase() === "news")
          .filter(visible);
        if (!candidates.length) return { found: false, href: null };
        let target = candidates[candidates.length - 1];
        target = target.closest('a,button,[role="tab"],[role="button"]') || target;
        return { found: true, href: target.href || null };
      });
      if (!result.found) continue;
      if (result.href) await gotoSafe(page, result.href);
      else await frame.evaluate(() => {
        let target = [...document.querySelectorAll('a,button,[role="tab"],[role="button"],div,span,li')]
          .find(el => String(el.innerText || el.textContent || "").trim().toLowerCase() === "news");
        target = target?.closest('a,button,[role="tab"],[role="button"]') || target;
        target?.click();
      });
      await sleep(1800);
      return true;
    } catch {}
  }
  return false;
}

async function scrapeNews(page) {
  const all = [];
  const diagnostics = [];

  for (const frame of page.frames()) {
    try {
      const result = await frame.evaluate(() => {
        const clean = value => String(value || "").replace(/\s+/g, " ").trim();
        const linesOf = el => String(el?.innerText || "").split(/\n+/).map(clean).filter(Boolean);
        const dateRe = /\b\d{1,2}\/\d{1,2}\b/;
        const timeRe = /\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/i;
        const gradeRe = /^(?:A|A-|A\+|B|B-|B\+|C|C-|C\+|D|D-|D\+|F|EC|NG|--|—)$/i;
        const percentRe = /^(?:1\d\d|\d{1,2})%$/;
        const items = [];
        let rowsWithDateTime = 0;

        const makeItem = (grade, percent, date, time, title, course) => {
          title = clean(title);
          course = clean(course);
          grade = clean(grade).toUpperCase();
          percent = clean(percent);
          date = clean(date);
          time = clean(time).toUpperCase();
          if (!date || !time || !title || !course) return null;
          const key = [date, time, course, title, grade, percent].join("|").toLowerCase();
          return { grade, percent, date, time, title, course, key };
        };

        for (const row of document.querySelectorAll("tr")) {
          const cells = [...row.querySelectorAll(":scope > td, :scope > th")];
          if (cells.length < 2) continue;
          const cellLines = cells.map(linesOf);
          const flat = cellLines.flat();
          const joined = flat.join("\n");
          const dateMatch = joined.match(dateRe);
          const timeMatch = joined.match(timeRe);
          if (!dateMatch || !timeMatch) continue;
          rowsWithDateTime++;

          let grade = "", percent = "";
          for (const line of cellLines[0] || []) {
            if (!grade && gradeRe.test(line)) grade = line;
            if (!percent && percentRe.test(line)) percent = line;
          }
          if (!grade) grade = flat.find(line => gradeRe.test(line)) || "";
          if (!percent) percent = flat.find(line => percentRe.test(line)) || "";

          let detailLines = linesOf(cells[cells.length - 1]).filter(line =>
            !dateRe.test(line) && !timeRe.test(line) && !gradeRe.test(line) && !percentRe.test(line)
          );

          if (detailLines.length < 2) {
            detailLines = flat.filter(line =>
              !dateRe.test(line) && !timeRe.test(line) && !gradeRe.test(line) && !percentRe.test(line)
            );
          }

          if (detailLines.length >= 2) {
            const course = detailLines[detailLines.length - 1];
            const title = detailLines.slice(0, -1).join(" ");
            const item = makeItem(grade, percent, dateMatch[0], timeMatch[0], title, course);
            if (item) items.push(item);
          }
        }

        if (!items.length) {
          const containers = [...document.querySelectorAll("div,li,article,section")];
          for (const el of containers) {
            const lines = linesOf(el);
            if (lines.length < 4 || lines.length > 20) continue;
            const joined = lines.join("\n");
            const dateMatch = joined.match(dateRe);
            const timeMatch = joined.match(timeRe);
            if (!dateMatch || !timeMatch) continue;

            const childHasSame = [...el.querySelectorAll("div,li,article,section")].some(child => {
              if (child === el) return false;
              const t = String(child.innerText || "");
              return dateRe.test(t) && timeRe.test(t);
            });
            if (childHasSame) continue;

            let grade = lines.find(line => gradeRe.test(line)) || "";
            let percent = lines.find(line => percentRe.test(line)) || "";
            const metadataFiltered = lines.filter(line =>
              !dateRe.test(line) && !timeRe.test(line) && !gradeRe.test(line) && !percentRe.test(line)
            );
            if (metadataFiltered.length < 2) continue;
            const course = metadataFiltered[metadataFiltered.length - 1];
            const title = metadataFiltered.slice(0, -1).join(" ");
            const item = makeItem(grade, percent, dateMatch[0], timeMatch[0], title, course);
            if (item) items.push(item);
          }
        }

        const unique = [];
        const seen = new Set();
        for (const item of items) {
          if (seen.has(item.key)) continue;
          seen.add(item.key);
          unique.push(item);
        }

        return {
          items: unique,
          diagnostics: {
            title: document.title || "",
            tableCount: document.querySelectorAll("table").length,
            rowCount: document.querySelectorAll("tr").length,
            rowsWithDateTime
          }
        };
      });
      all.push(...result.items);
      diagnostics.push(result.diagnostics);
    } catch {}
  }

  const unique = [];
  const keys = new Set();
  for (const item of all) {
    if (keys.has(item.key)) continue;
    keys.add(item.key);
    unique.push(item);
  }

  return { items: unique, diagnostics };
}

function activityLine(item) {
  let title = item.title;
  let points = "";
  const match = title.match(/^(.*)\s+\(([^()]+)\)$/);
  if (match) {
    title = match[1].trim();
    points = match[2].trim();
  }
  const scoreParts = [points, item.percent, item.grade].filter(Boolean);
  const score = scoreParts.length ? ` · ${scoreParts.join(" · ")}` : "";
  return `${cleanCourseName(item.course)} — ${title}${score} · ${item.date} ${item.time}`;
}

async function writeDebug(page, reason, diagnostics = []) {
  const payload = {
    at: new Date().toISOString(),
    reason,
    page: (() => {
      try { const u = new URL(page.url()); return { host: u.hostname, path: u.pathname }; }
      catch { return { host: "unknown", path: "" }; }
    })(),
    diagnostics,
    trace
  };
  await fs.writeFile(DEBUG_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
const context = await browser.newContext({ locale: "en-US", timezoneId: "America/New_York", viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

try {
  log("Logging into Focus.");
  if (!(await automaticFocusLogin(page))) throw new Error("Focus login failed for News collector.");
  if (!(await openNewsTab(page))) throw new Error("Focus News tab was not found.");

  const { items, diagnostics } = await scrapeNews(page);
  log(`Parsed ${items.length} Focus News rows.`);

  if (!items.length) {
    await writeDebug(page, "News page opened but zero assignment rows parsed.", diagnostics);
    throw new Error("Focus News opened but zero activity rows were parsed.");
  }

  const previousState = await readJSON(STATE_PATH, {});
  const oldSeen = new Set(Array.isArray(previousState.seenHashes) ? previousState.seenHashes : []);
  const hashed = items.map(item => ({ item, hash: digest(item.key) }));
  const firstSuccessfulSync = !previousState.initialized;
  const newItems = firstSuccessfulSync ? hashed : hashed.filter(entry => !oldSeen.has(entry.hash));
  const recent = items.slice(0, 15);

  const data = await readJSON(DATA_PATH, null);
  if (!data) throw new Error("data.json could not be read.");

  data.activityStatus = firstSuccessfulSync
    ? `Loaded ${recent.length} recent`
    : newItems.length ? `${newItems.length} new` : "Up to date";
  data.activity = recent.map(activityLine);
  data.updatedAt = new Date().toISOString();

  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fs.writeFile(STATE_PATH, JSON.stringify({
    initialized: true,
    seenHashes: [...new Set([...(previousState.seenHashes || []), ...hashed.map(entry => entry.hash)])].slice(-1500),
    updatedAt: new Date().toISOString()
  }, null, 2) + "\n", "utf8");

  await fs.rm(DEBUG_PATH, { force: true }).catch(() => {});
  log(`Published ${recent.length} recent activity rows; ${newItems.length} new.`);
} catch (error) {
  await writeDebug(page, String(error)).catch(() => {});
  throw error;
} finally {
  await browser.close();
}

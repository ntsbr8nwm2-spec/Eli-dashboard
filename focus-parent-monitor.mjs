import { chromium } from "playwright";
import fs from "node:fs/promises";

const USERNAME = process.env.BCPS_USERNAME || "";
const PASSWORD = process.env.BCPS_PASSWORD || "";
const STUDENT_FIRST_NAME = String(process.env.STUDENT_FIRST_NAME || "").trim();
const LOGIN_URL = "https://browardschools.focusschoolsoftware.com/focus/auth/index.php?action=login";
const GRADES_URL = "https://browardschools.focusschoolsoftware.com/focus/Modules.php?force_package=SIS&modname=Grades/StudentRCGrades.php&details=false";
const DATA_PATH = "data.json";
const DEBUG_PATH = "parent-focus-debug.json";

if (!USERNAME || !PASSWORD) throw new Error("Focus Parent Portal credentials are missing.");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = s => console.log(`[PARENT-FOCUS] ${s}`);

function schoolYear() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric" }).formatToParts(new Date());
  const y = Number(p.find(x => x.type === "year")?.value);
  const m = Number(p.find(x => x.type === "month")?.value);
  return m >= 7 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

function dateLabel() {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(new Date());
}

function gradeParts(value) {
  const text = String(value || "").trim();
  const pct = text.match(/(\d{1,3})%/);
  const letter = text.match(/\b([A-F][+-]?)\b/i);
  return { percent: pct ? Number(pct[1]) : null, letter: letter ? letter[1].toUpperCase() : "NG" };
}

function safeUrl(value) {
  try { const u = new URL(value); return { host: u.hostname.toLowerCase(), path: u.pathname }; }
  catch { return { host: "unknown", path: "" }; }
}

async function gotoSafe(page, url) {
  try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 18000 }); }
  catch (e) {
    const t = String(e || "");
    if (!t.includes("ERR_ABORTED") && !t.includes("Navigation interrupted") && !t.includes("interrupted by another navigation")) throw e;
  }
}

async function parentLogin(page) {
  await gotoSafe(page, LOGIN_URL);
  await sleep(800);

  const user = page.locator('input[name="username"],input[type="email"],input[type="text"]').filter({ visible: true }).first();
  const pass = page.locator('input[name="password"],input[type="password"]').filter({ visible: true }).first();
  if (!(await user.count()) || !(await pass.count())) throw new Error("Focus Parent Portal login form was not found.");

  await user.fill(USERNAME);
  await pass.fill(PASSWORD);

  const submitted = await page.evaluate(() => {
    const p = document.querySelector('input[name="password"],input[type="password"]');
    const form = p?.form;
    if (!form) return false;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else HTMLFormElement.prototype.submit.call(form);
    return true;
  }).catch(() => false);
  if (!submitted) throw new Error("Focus Parent Portal login could not be submitted.");

  await sleep(2500);
  const state = await page.evaluate(() => {
    const text = String(document.body?.innerText || "");
    const lower = text.toLowerCase();
    return {
      stillLogin: Boolean(document.querySelector('input[name="password"],input[type="password"]')) && lower.includes("username"),
      invalid: lower.includes("invalid username") || lower.includes("invalid password") || lower.includes("incorrect password") || lower.includes("login failed"),
      logout: lower.includes("log out") || lower.includes("logout"),
      bodyLength: text.length
    };
  }).catch(() => ({}));

  if (state.invalid || state.stillLogin) throw new Error("Focus Parent Portal login was not accepted.");
  log(`Parent Portal accepted login; host=${safeUrl(page.url()).host}.`);
}

async function chooseStudentIfNeeded(page) {
  if (!STUDENT_FIRST_NAME) return;
  const wanted = STUDENT_FIRST_NAME.toLowerCase();
  const result = await page.evaluate(wantedName => {
    const visible = el => {
      const s = getComputedStyle(el); const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
    };
    const candidates = [...document.querySelectorAll('a,button,[role="button"],option')]
      .filter(visible)
      .map(el => ({ el, label: String(el.innerText || el.textContent || "").replace(/\s+/g," ").trim() }))
      .filter(x => x.label && x.label.toLowerCase().includes(wantedName));
    if (candidates.length !== 1) return { matches: candidates.length, clicked: false };
    const target = candidates[0].el;
    if (target.tagName === "OPTION") {
      const select = target.parentElement;
      if (!(select instanceof HTMLSelectElement)) return { matches: 1, clicked: false };
      select.value = target.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return { matches: 1, clicked: true };
    }
    target.click();
    return { matches: 1, clicked: true };
  }, wanted).catch(() => ({ matches: 0, clicked: false }));

  if (result.clicked) {
    log("Selected matching linked student.");
    await sleep(1400);
  } else if (result.matches > 1) {
    log("Multiple matching student controls were present; leaving current selection unchanged.");
  }
}

function parseRows(rows, year) {
  const gradePattern = /^(?:NG|\d{1,3}%\s*[A-F][+-]?|[A-F][+-]?)$/i;
  const out = [];

  for (const cells of rows) {
    const yi = cells.findIndex(v => String(v).replace(/\s/g,"").includes(year.replace(/\s/g,"")));
    if (yi < 0) continue;

    // Known Broward student-layout parser first.
    let period = cells[yi + 2] || "";
    let key = cells[yi + 4] || "";
    let course = cells[yi + 5] || "";
    let teacher = cells[yi + 6] || "";

    const gradeTokens = cells.slice(yi + 1).filter(v => gradePattern.test(String(v).trim()));
    if (!gradeTokens.length) continue;

    // Parent/mobile layouts can shift columns. If the known course slot is empty or grade-like,
    // choose the strongest text candidate between year and the first grade token.
    if (!course || gradePattern.test(String(course).trim())) {
      const firstGradeIndex = cells.findIndex((v, i) => i > yi && gradePattern.test(String(v).trim()));
      const candidates = cells.slice(yi + 1, firstGradeIndex > yi ? firstGradeIndex : cells.length)
        .map((v, i) => ({ value: String(v || "").trim(), index: yi + 1 + i }))
        .filter(x => x.value && !/^\d+$/.test(x.value) && !/^\d{1,2}:\d{2}/.test(x.value));
      const best = candidates.sort((a,b) => b.value.length - a.value.length)[0];
      if (best) course = best.value;
      if (!key) key = `${period}-${course}`;
    }

    if (!course) continue;
    out.push({ key: key || `${period}-${course}`, period, course, teacher, latest: gradeTokens.at(-1) || "NG", gradeTokens });
  }

  const seen = new Set();
  return out.filter(x => { const k = String(x.key || x.course).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function scrapeGrades(page) {
  await gotoSafe(page, GRADES_URL);
  await sleep(1800);
  await chooseStudentIfNeeded(page);
  await gotoSafe(page, GRADES_URL);
  await sleep(1400);

  const year = schoolYear();
  for (const frame of page.frames()) {
    const rows = await frame.evaluate(() => [...document.querySelectorAll("tr")].map(tr => [...tr.querySelectorAll("th,td")].map(td => String(td.innerText || "").replace(/\s+/g," ").trim()))).catch(() => []);
    const courses = parseRows(rows, year);
    if (courses.length) return { year, courses };
  }

  const diag = await page.evaluate(yearValue => {
    const text = String(document.body?.innerText || "");
    const rows = [...document.querySelectorAll("tr")];
    return {
      host: location.hostname,
      path: location.pathname,
      bodyLength: text.length,
      tableCount: document.querySelectorAll("table").length,
      rowCount: rows.length,
      hasYear: text.replace(/\s/g,"").includes(yearValue.replace(/\s/g,"")),
      focusLogin: text.toLowerCase().includes("sign in with microsoft"),
      rowShapes: rows.slice(0,20).map(tr => [...tr.querySelectorAll("th,td")].map(td => String(td.innerText || "").trim()).filter(Boolean).length)
    };
  }, year).catch(() => ({}));
  await fs.writeFile(DEBUG_PATH, JSON.stringify({ at: new Date().toISOString(), diag }, null, 2) + "\n").catch(() => {});
  throw new Error("Focus Parent Portal opened, but current-year grade rows were not readable.");
}

async function readData() { try { return JSON.parse(await fs.readFile(DATA_PATH, "utf8")); } catch { return {}; } }

async function writeGrades(courses) {
  const old = await readData();
  const oldBy = new Map((Array.isArray(old.grades) ? old.grades : []).map(x => [String(x.course || "").toLowerCase(), x]));
  let changes = 0;
  const grades = courses.map(c => {
    const name = String(c.course || "").trim();
    const parsed = gradeParts(c.latest);
    const prior = oldBy.get(name.toLowerCase());
    let change = "";
    if (!prior) { change = "NEW"; changes++; }
    else if ((prior.percent ?? null) !== parsed.percent || String(prior.letter || "NG") !== parsed.letter) { change = "CHANGED"; changes++; }
    return { course: name, display: c.latest || "NG", percent: parsed.percent, letter: parsed.letter, change };
  });

  const data = {
    dateLabel: dateLabel(),
    updatedAt: new Date().toISOString(),
    gradeStatus: changes ? `🚨 ${changes} change${changes === 1 ? "" : "s"}` : "Current grades",
    grades,
    assignments: [],
    activityStatus: "Focus Parent Portal connection",
    activity: []
  };
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  log(`Prepared ${grades.length} grades from Focus Parent Portal.`);
}

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
const context = await browser.newContext({ locale: "en-US", timezoneId: "America/New_York", viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

try {
  await parentLogin(page);
  await chooseStudentIfNeeded(page);
  const result = await scrapeGrades(page);
  await writeGrades(result.courses);
  await fs.rm(DEBUG_PATH, { force: true }).catch(() => {});
} catch (e) {
  const safe = { at: new Date().toISOString(), error: String(e), page: safeUrl(page.url()) };
  await fs.writeFile(DEBUG_PATH, JSON.stringify(safe, null, 2) + "\n").catch(() => {});
  throw e;
} finally {
  await browser.close();
}

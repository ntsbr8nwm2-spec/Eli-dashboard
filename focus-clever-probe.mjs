import { chromium } from "playwright";

const USERNAME = process.env.BCPS_USERNAME || "";
const PASSWORD = process.env.BCPS_PASSWORD || "";
const CLEVER_URL = "https://sso.browardschools.com/";
const GRADES_URL = "https://browardschools.focusschoolsoftware.com/focus/Modules.php?force_package=SIS&modname=Grades/StudentRCGrades.php&details=false";

if (!USERNAME || !PASSWORD) throw new Error("Missing school credentials");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const safeUrl = value => {
  try { const u = new URL(value); return { host: u.hostname.toLowerCase(), path: u.pathname }; }
  catch { return { host: "unknown", path: "" }; }
};

async function gotoSafe(page, url) {
  try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }); }
  catch (e) {
    const t = String(e || "");
    if (!t.includes("ERR_ABORTED") && !t.includes("Navigation interrupted") && !t.includes("interrupted by another navigation")) throw e;
  }
}

async function submitSAML(page, name) {
  return page.evaluate(n => {
    const i = document.querySelector(`input[name="${n}"]`);
    if (!i?.form) return false;
    setTimeout(() => HTMLFormElement.prototype.submit.call(i.form), 20);
    return true;
  }, name).catch(() => false);
}

async function state(page) {
  return page.evaluate(() => {
    const text = String(document.body?.innerText || "");
    const l = text.toLowerCase();
    const h = String(location.hostname || "").toLowerCase();
    return {
      host: h,
      cleverHome: h.includes("clever.com") && (l.includes("resources") || l.includes("portal") || l.includes("applications")),
      adButton: l.includes("log in with active directory"),
      adForm: Boolean(document.querySelector('#userNameInput,input[name="UserName"],input[name="username"]')) && Boolean(document.querySelector('#passwordInput,input[name="Password"],input[type="password"]')),
      msUser: Boolean(document.querySelector('#i0116,input[name="loginfmt"]')),
      msPass: Boolean(document.querySelector('#i0118,input[name="passwd"]')),
      samlRequest: Boolean(document.querySelector('input[name="SAMLRequest"]')),
      samlResponse: Boolean(document.querySelector('input[name="SAMLResponse"]')),
      stay: l.includes("stay signed in"),
      conditionalAccess: l.includes("you cannot access this right now") || l.includes("you can't access this right now") || l.includes("doesn't meet the criteria to access this resource") || l.includes("does not meet the criteria to access this resource") || l.includes("restricted by your admin") || l.includes("restricted by your administrator"),
      focusLoggedIn: h.includes("focusschoolsoftware.com") && !l.includes("sign in with microsoft") && (l.includes("log out") || l.includes("grades") || l.includes("student"))
    };
  }).catch(() => ({}));
}

async function clickAD(page) {
  const r = await page.evaluate(() => {
    const e = [...document.querySelectorAll('a,button,[role="button"]')].find(x => String(x.innerText || x.textContent || "").toLowerCase().includes("log in with active directory"));
    return e ? { ok: true, href: e.href || e.closest("a")?.href || null } : { ok: false };
  }).catch(() => ({ ok: false }));
  if (!r.ok) return false;
  if (r.href) await gotoSafe(page, r.href);
  else await page.evaluate(() => [...document.querySelectorAll('a,button,[role="button"]')].find(x => String(x.innerText || x.textContent || "").toLowerCase().includes("log in with active directory"))?.click()).catch(() => {});
  return true;
}

async function submitAD(page) {
  const u = page.locator('#userNameInput,input[name="UserName"],input[name="username"]').first();
  const p = page.locator('#passwordInput,input[name="Password"],input[type="password"]').first();
  if (!(await u.count()) || !(await p.count())) return false;
  await u.fill(USERNAME.split("@")[0]);
  await p.fill(PASSWORD);
  const b = page.locator('#submitButton,button[type="submit"],input[type="submit"]').first();
  if (await b.count()) await b.click();
  return true;
}

async function submitMSUser(page) {
  const i = page.locator('#i0116,input[name="loginfmt"]').first();
  if (!(await i.count())) return false;
  await i.fill(USERNAME);
  await page.locator('#idSIButton9').first().click().catch(() => {});
  return true;
}

async function submitMSPass(page) {
  const i = page.locator('#i0118,input[name="passwd"]').first();
  if (!(await i.count())) return false;
  await i.fill(PASSWORD);
  await page.locator('#idSIButton9').first().click().catch(() => {});
  return true;
}

async function clickFocusTile(page) {
  const r = await page.evaluate(() => {
    const low = v => String(v || "").toLowerCase();
    const direct = [...document.querySelectorAll('a[href]')].find(a => low(a.href).includes("focusschoolsoftware.com"));
    if (direct) return { ok: true, href: direct.href };
    let e = [...document.querySelectorAll('a,button,div,span,img')].find(x => [x.innerText, x.textContent, x.getAttribute?.("aria-label"), x.getAttribute?.("title"), x.getAttribute?.("alt")].some(v => /^\s*focus\s*$/i.test(String(v || "")) || low(v).includes("focus school")));
    for (let i = 0; e && i < 10; i++, e = e.parentElement) {
      if (e.tagName === "A" && e.href) return { ok: true, href: e.href };
      const a = e.querySelector?.('a[href]');
      if (a?.href) return { ok: true, href: a.href };
    }
    return { ok: false, href: null };
  }).catch(() => ({ ok: false, href: null }));
  if (!r.ok) return false;
  await gotoSafe(page, r.href);
  return true;
}

async function inspectGrades(page) {
  await gotoSafe(page, GRADES_URL).catch(() => {});
  await sleep(1800);
  return page.evaluate(() => {
    const text = String(document.body?.innerText || "");
    const rows = [...document.querySelectorAll('tr')];
    const yearRows = rows.filter(tr => String(tr.innerText || "").includes("2026-2027"));
    const gradeLike = [...document.querySelectorAll('td,th')].map(x => String(x.innerText || "").trim()).filter(v => /^(?:NG|\d{1,3}%\s*[A-F][+-]?|[A-F][+-]?)$/i.test(v));
    return {
      focusLoginPresent: text.toLowerCase().includes("sign in with microsoft"),
      logoutPresent: text.toLowerCase().includes("log out"),
      yearRowCount: yearRows.length,
      gradeLikeCellCount: gradeLike.length,
      tableCount: document.querySelectorAll("table").length
    };
  }).catch(() => ({}));
}

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
const context = await browser.newContext({ locale: "en-US", timezoneId: "America/New_York", viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const result = {
  activeDirectoryUsed: false,
  microsoftUsed: false,
  cleverReached: false,
  focusTileFound: false,
  focusReached: false,
  conditionalAccess: false,
  grades: null,
  final: null
};

try {
  await gotoSafe(page, CLEVER_URL);
  await sleep(1200);
  const deadline = Date.now() + 50000;
  let adClicks = 0, adSubmits = 0, msUsers = 0, msPasses = 0, requests = 0, responses = 0, stays = 0, tiles = 0;

  while (Date.now() < deadline) {
    const s = await state(page);
    if (s.conditionalAccess) { result.conditionalAccess = true; break; }
    if (s.focusLoggedIn) { result.focusReached = true; break; }
    if (s.cleverHome) {
      result.cleverReached = true;
      if (tiles < 4) {
        tiles++;
        if (await clickFocusTile(page)) { result.focusTileFound = true; await sleep(1800); continue; }
      }
    }
    if (s.adButton && adClicks < 3) { adClicks++; result.activeDirectoryUsed = true; if (await clickAD(page)) { await sleep(900); continue; } }
    if (s.adForm && adSubmits < 3) { adSubmits++; result.activeDirectoryUsed = true; if (await submitAD(page)) { await sleep(1400); continue; } }
    if (s.samlRequest && requests < 3) { requests++; await submitSAML(page, "SAMLRequest"); await sleep(800); continue; }
    if (s.msUser && msUsers < 2) { msUsers++; result.microsoftUsed = true; if (await submitMSUser(page)) { await sleep(900); continue; } }
    if (s.msPass && msPasses < 2) { msPasses++; result.microsoftUsed = true; if (await submitMSPass(page)) { await sleep(1000); continue; } }
    if (s.stay && stays < 2) { stays++; await page.locator('#idSIButton9').first().click().catch(() => {}); await sleep(900); continue; }
    if (s.samlResponse && responses < 3) { responses++; await submitSAML(page, "SAMLResponse"); await sleep(1200); continue; }
    await sleep(450);
  }

  const s = await state(page);
  if (s.cleverHome) result.cleverReached = true;
  if (s.focusLoggedIn) result.focusReached = true;
  if (result.focusReached || result.focusTileFound) result.grades = await inspectGrades(page);
  result.final = safeUrl(page.url());
  console.log("[CLEVER-FOCUS-PROBE]", JSON.stringify(result));
} finally {
  await browser.close();
}

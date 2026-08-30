import { chromium } from "playwright";

const GRADES_URL = "https://browardschools.focusschoolsoftware.com/focus/Modules.php?force_package=SIS&modname=Grades/StudentRCGrades.php&details=false";
const USERNAME = process.env.BCPS_USERNAME || "";
const PASSWORD = process.env.BCPS_PASSWORD || "";

if (!USERNAME || !PASSWORD) throw new Error("Missing school credentials");

const sleep = ms => new Promise(r => setTimeout(r, ms));
function safeUrl(value) {
  try {
    const u = new URL(value);
    return { host: u.hostname.toLowerCase(), path: u.pathname };
  } catch {
    return { host: "unknown", path: "" };
  }
}

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: ["--disable-dev-shm-usage"]
});
const context = await browser.newContext({ locale: "en-US", timezoneId: "America/New_York" });
const page = await context.newPage();

try {
  await page.goto(GRADES_URL, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  await sleep(1000);

  const sso = await page.evaluate(() => {
    const el = [...document.querySelectorAll('a,button,input,[role="button"]')].find(x =>
      String(x.innerText || x.value || x.textContent || "").toLowerCase().includes("sign in with microsoft")
    );
    return el ? (el.href || el.closest("a")?.href || "CLICK") : null;
  }).catch(() => null);

  if (sso && sso !== "CLICK") {
    await page.goto(sso, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  } else if (sso === "CLICK") {
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('a,button,input,[role="button"]')].find(x =>
        String(x.innerText || x.value || x.textContent || "").toLowerCase().includes("sign in with microsoft")
      );
      el?.click();
    }).catch(() => {});
  }

  await page.locator('#i0116,input[name="loginfmt"]').first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const user = page.locator('#i0116,input[name="loginfmt"]').first();
  if (await user.count()) {
    await user.fill(USERNAME);
    await page.locator('#idSIButton9').first().click().catch(() => {});
  }

  await page.locator('#i0118,input[name="passwd"]').first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const pass = page.locator('#i0118,input[name="passwd"]').first();
  if (await pass.count()) {
    await pass.fill(PASSWORD);
    await page.locator('#idSIButton9').first().click().catch(() => {});
  }

  await sleep(6000);

  const state = await page.evaluate(() => {
    const text = String(document.body?.innerText || "");
    const lower = text.toLowerCase();
    return {
      conditionalAccess: lower.includes("you cannot access this right now") || lower.includes("you can't access this right now") || lower.includes("does not meet the criteria to access this resource") || lower.includes("doesn't meet the criteria to access this resource") || lower.includes("restricted by your admin") || lower.includes("security policy"),
      vpnPolicyText: lower.includes("personal vpn") || lower.includes("vpn"),
      focusLoggedIn: String(location.hostname || "").toLowerCase().includes("focusschoolsoftware.com") && !lower.includes("sign in with microsoft"),
      cleverReached: String(location.hostname || "").toLowerCase().includes("clever.com"),
      bodyLength: text.length
    };
  }).catch(() => ({}));

  console.log("[FULL-CHROME-PROBE]", JSON.stringify({ page: safeUrl(page.url()), title: await page.title().catch(() => ""), ...state }));
} finally {
  await context.close();
  await browser.close();
}

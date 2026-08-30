import { chromium } from "playwright";

const GRADES_URL = "https://browardschools.focusschoolsoftware.com/focus/Modules.php?force_package=SIS&modname=Grades/StudentRCGrades.php&details=false";
const USERNAME = process.env.BCPS_USERNAME || "";
const PASSWORD = process.env.BCPS_PASSWORD || "";

if (!USERNAME || !PASSWORD) throw new Error("Missing school credentials");

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
const context = await browser.newContext({ locale: "en-US", timezoneId: "America/New_York" });
const page = await context.newPage();

function safeUrl(value) {
  try {
    const u = new URL(value);
    return { host: u.hostname.toLowerCase(), path: u.pathname };
  } catch {
    return { host: "unknown", path: "" };
  }
}

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

try {
  await page.goto(GRADES_URL, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await wait(800);

  const sso = await page.evaluate(() => {
    const el = [...document.querySelectorAll('a,button,input,[role="button"]')].find(x =>
      String(x.innerText || x.value || x.textContent || "").toLowerCase().includes("sign in with microsoft")
    );
    if (!el) return null;
    return el.href || el.closest("a")?.href || "CLICK";
  }).catch(() => null);

  if (sso && sso !== "CLICK") {
    await page.goto(sso, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  } else if (sso === "CLICK") {
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('a,button,input,[role="button"]')].find(x =>
        String(x.innerText || x.value || x.textContent || "").toLowerCase().includes("sign in with microsoft")
      );
      el?.click();
    }).catch(() => {});
  }

  await page.locator('#i0116, input[name="loginfmt"]').first().waitFor({ state: "visible", timeout: 12000 }).catch(() => {});
  const userInput = page.locator('#i0116, input[name="loginfmt"]').first();
  if (await userInput.count()) {
    await userInput.fill(USERNAME);
    await page.locator('#idSIButton9').first().click().catch(() => {});
  }

  await page.locator('#i0118, input[name="passwd"]').first().waitFor({ state: "visible", timeout: 12000 }).catch(() => {});
  const passInput = page.locator('#i0118, input[name="passwd"]').first();
  if (await passInput.count()) {
    await passInput.fill(PASSWORD);
    await page.locator('#idSIButton9').first().click().catch(() => {});
  }

  await wait(5000);

  const state = await page.evaluate(() => {
    const text = String(document.body?.innerText || "");
    const lower = text.toLowerCase();
    const has = (...phrases) => phrases.some(p => lower.includes(p));
    return {
      passwordInputPresent: Boolean(document.querySelector('#i0118, input[name="passwd"]')),
      usernameInputPresent: Boolean(document.querySelector('#i0116, input[name="loginfmt"]')),
      passwordRejected: has("password is incorrect", "incorrect password", "your account or password is incorrect", "password you entered is incorrect"),
      accountLocked: has("account has been locked", "account is locked", "temporarily locked"),
      passwordExpired: has("password has expired", "update your password", "change your password"),
      moreInfoRequired: has("more information required", "more info required"),
      mfaChallenge: has("approve sign in request", "approve sign-in request", "enter code", "verification code", "verify your identity", "use your authenticator app"),
      staySignedIn: has("stay signed in"),
      accessBlocked: has("sign-in was blocked", "sign in was blocked", "you can't sign in here", "access has been blocked", "access denied"),
      genericTrouble: has("sorry, but we're having trouble signing you in", "we couldn't sign you in", "we could not sign you in"),
      samlResponse: Boolean(document.querySelector('input[name="SAMLResponse"]')),
      samlRequest: Boolean(document.querySelector('input[name="SAMLRequest"]')),
      continuePrompt: has("continue"),
      bodyLength: text.length
    };
  }).catch(() => ({}));

  console.log("[AUTH-PROBE]", JSON.stringify({ page: safeUrl(page.url()), title: await page.title().catch(() => ""), ...state }));
} finally {
  await browser.close();
}

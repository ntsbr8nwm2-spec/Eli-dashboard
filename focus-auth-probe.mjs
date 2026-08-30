import { chromium } from "playwright";

const GRADES_URL = "https://browardschools.focusschoolsoftware.com/focus/Modules.php?force_package=SIS&modname=Grades/StudentRCGrades.php&details=false";
const USERNAME = process.env.BCPS_USERNAME || "";
const PASSWORD = process.env.BCPS_PASSWORD || "";

if (!USERNAME || !PASSWORD) throw new Error("Missing school credentials");

function safeUrl(value) {
  try {
    const u = new URL(value);
    return { host: u.hostname.toLowerCase(), path: u.pathname };
  } catch {
    return { host: "unknown", path: "" };
  }
}

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function probeMicrosoft(browser) {
  const context = await browser.newContext({ locale: "en-US", timezoneId: "America/New_York" });
  const page = await context.newPage();
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
      const aadsts = text.match(/AADSTS\d{5,}/i)?.[0]?.toUpperCase() || null;

      const safeIds = [
        "idSIButton9", "idBtn_Back", "idDiv_SAOTCS_Proofs", "idDiv_SAOTCC_Description",
        "idDiv_SAOTCS_Proofs_Section", "idDiv_SAOTCC_Title", "idDiv_SAOTCS_Title",
        "idDiv_RemoteNgc_PollingDescription", "idDiv_RemoteNgc_Title", "idDiv_SAOTCAS_Title",
        "idDiv_SAOTCAS_Description", "idRichContext_DisplaySign", "idRichContext_DisplaySignDescription",
        "idRichContext_DisplaySignDescriptionLink", "idDiv_SAOTCS_ProofConfirmation",
        "idDiv_SAOTCS_ProofConfirmationDesc", "idDiv_SAOTCS_ProofConfirmationTitle"
      ].filter(id => Boolean(document.getElementById(id)));

      const safeButtonLabels = [
        "yes", "no", "continue", "next", "back", "cancel", "accept", "decline", "skip for now",
        "sign in another way", "use a different verification option",
        "i can't use my microsoft authenticator app right now", "approve", "done", "try again"
      ];

      const visibleSafeButtons = [...document.querySelectorAll('button,input[type="submit"],input[type="button"],a,[role="button"]')]
        .filter(el => {
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
        })
        .map(el => String(el.innerText || el.value || el.textContent || "").trim().toLowerCase())
        .filter(label => safeButtonLabels.includes(label))
        .filter((label, i, arr) => arr.indexOf(label) === i);

      return {
        passwordInputPresent: Boolean(document.querySelector('#i0118, input[name="passwd"]')),
        usernameInputPresent: Boolean(document.querySelector('#i0116, input[name="loginfmt"]')),
        passwordRejected: has("password is incorrect", "incorrect password", "your account or password is incorrect", "password you entered is incorrect"),
        accountLocked: has("account has been locked", "account is locked", "temporarily locked"),
        accountDisabled: has("account has been disabled", "account is disabled"),
        passwordExpired: has("password has expired", "update your password", "change your password"),
        moreInfoRequired: has("more information required", "more info required", "your organization needs more information", "additional information is required"),
        keepAccountSecure: has("keep your account secure", "let's keep your account secure", "help us protect your account", "set up your account"),
        mfaChallenge: has("approve sign in request", "approve sign-in request", "verification code", "verify your identity", "use your authenticator app", "choose a verification method", "sign in another way"),
        staySignedIn: has("stay signed in"),
        caCantGetThere: has("you can't get there from here"),
        caCannotAccessNow: has("you cannot access this right now", "you can't access this right now"),
        caCriteria: has("doesn't meet the criteria to access this resource", "does not meet the criteria to access this resource", "your sign-in was successful but"),
        caManagedDevice: has("device must be managed", "device needs to be managed", "compliant device"),
        caAdminRestriction: has("restricted by your admin", "restricted by your administrator", "your organization requires"),
        accessBlocked: has("sign-in was blocked", "sign in was blocked", "you can't sign in here", "you cannot sign in here", "access has been blocked", "access denied", "request denied"),
        permissionsRequested: has("permissions requested", "review permissions", "accept the permissions", "consent on behalf"),
        termsFooterPresent: has("terms of use"),
        suspiciousActivity: has("suspicious activity", "unusual activity"),
        authenticatorNumberMatch: has("enter the number shown", "match the number", "number matching"),
        deviceCodePrompt: has("enter the code displayed", "code displayed on your app", "enter a code from your device"),
        genericTrouble: has("sorry, but we're having trouble signing you in", "we couldn't sign you in", "we could not sign you in", "something went wrong"),
        samlResponse: Boolean(document.querySelector('input[name="SAMLResponse"]')),
        samlRequest: Boolean(document.querySelector('input[name="SAMLRequest"]')),
        aadsts,
        safeIds,
        visibleSafeButtons,
        bodyLength: text.length
      };
    }).catch(() => ({}));

    console.log("[AUTH-PROBE]", JSON.stringify({ page: safeUrl(page.url()), title: await page.title().catch(() => ""), ...state }));
  } finally {
    await context.close();
  }
}

async function probeDirectFocus(browser) {
  const context = await browser.newContext({ locale: "en-US", timezoneId: "America/New_York" });
  const page = await context.newPage();
  try {
    await page.goto(GRADES_URL, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await wait(800);

    const before = await page.evaluate(() => {
      const user = document.querySelector('input[name="username"]');
      const pass = document.querySelector('input[name="password"]');
      const form = user?.form || pass?.form || null;
      const visible = el => {
        if (!el) return false;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
      };
      return {
        usernamePresent: Boolean(user),
        passwordPresent: Boolean(pass),
        usernameVisible: visible(user),
        passwordVisible: visible(pass),
        formPresent: Boolean(form),
        submitCount: form ? form.querySelectorAll('button,input[type="submit"],input[type="button"]').length : 0
      };
    }).catch(() => ({}));

    if (before.usernamePresent && before.passwordPresent) {
      await page.locator('input[name="username"]').first().fill(USERNAME).catch(() => {});
      await page.locator('input[name="password"]').first().fill(PASSWORD).catch(() => {});
      await page.evaluate(() => {
        const user = document.querySelector('input[name="username"]');
        const pass = document.querySelector('input[name="password"]');
        const form = user?.form || pass?.form;
        if (!form) return;
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else HTMLFormElement.prototype.submit.call(form);
      }).catch(() => {});
      await wait(3500);
      await page.goto(GRADES_URL, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await wait(1200);
    }

    const after = await page.evaluate(() => {
      const text = String(document.body?.innerText || "");
      const lower = text.toLowerCase();
      const gradeLike = [...document.querySelectorAll('td,th')]
        .map(x => String(x.innerText || "").trim())
        .filter(v => /^(?:NG|\d{1,3}%\s*[A-F][+-]?|[A-F][+-]?)$/i.test(v));
      return {
        focusLoginPresent: lower.includes("sign in with microsoft"),
        logoutPresent: lower.includes("log out"),
        schoolYearPresent: /2026\s*-\s*2027/.test(text),
        tableCount: document.querySelectorAll("table").length,
        rowCount: document.querySelectorAll("tr").length,
        gradeLikeCellCount: gradeLike.length,
        directError: lower.includes("invalid username") || lower.includes("invalid password") || lower.includes("incorrect username") || lower.includes("incorrect password") || lower.includes("login failed")
      };
    }).catch(() => ({}));

    console.log("[FOCUS-DIRECT-PROBE]", JSON.stringify({ before, after, page: safeUrl(page.url()), title: await page.title().catch(() => "") }));
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
try {
  await probeMicrosoft(browser);
  await probeDirectFocus(browser);
} finally {
  await browser.close();
}

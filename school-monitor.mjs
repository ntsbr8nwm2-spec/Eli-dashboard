import { chromium } from "playwright";
import fs from "node:fs/promises";

const FOCUS_PORTAL_URL =
  "https://browardschools.focusschoolsoftware.com/focus/";

const GRADES_URL =
  "https://browardschools.focusschoolsoftware.com/focus/Modules.php?force_package=SIS&modname=Grades/StudentRCGrades.php&details=false";

const USERNAME = process.env.BCPS_USERNAME || "";
const PASSWORD = process.env.BCPS_PASSWORD || "";

const DATA_PATH = "data.json";
const DEBUG_PATH = "auth-debug.json";

if (!USERNAME || !PASSWORD) {
  throw new Error("BCPS_USERNAME or BCPS_PASSWORD secret is missing.");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(text) {
  console.log(`[SCHOOL] ${text}`);
}

function hostFromURL(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
}

function currentSchoolYear() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric"
  }).formatToParts(new Date());

  const year = Number(parts.find(p => p.type === "year")?.value);
  const month = Number(parts.find(p => p.type === "month")?.value) - 1;

  return month >= 6
    ? `${year}-${year + 1}`
    : `${year - 1}-${year}`;
}

function dashboardDateLabel() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(new Date());
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

function gradeParts(value) {
  const text = String(value || "").trim();
  const pct = text.match(/(\d{1,3})%/);
  const letter = text.match(/\b([A-F][+-]?)\b/i);

  return {
    percent: pct ? Number(pct[1]) : null,
    letter: letter ? letter[1].toUpperCase() : "NG"
  };
}

async function gotoSafe(page, url) {
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });
  } catch (error) {
    const text = String(error || "");
    if (!text.includes("ERR_ABORTED") && !text.includes("Navigation interrupted")) {
      throw error;
    }
  }
}

async function submitSAMLForm(page, fieldName) {
  try {
    return await page.evaluate(field => {
      const input = document.querySelector(`input[name="${field}"]`);
      if (!input) return false;

      const form = input.closest("form");
      if (!form) return false;

      setTimeout(() => {
        HTMLFormElement.prototype.submit.call(form);
      }, 30);

      return true;
    }, fieldName);
  } catch {
    return false;
  }
}

async function submitMicrosoftUsername(page, username) {
  try {
    const input = page.locator('#i0116, input[name="loginfmt"]').first();
    if (!(await input.count())) return false;

    await input.fill(username);

    const button = page.locator("#idSIButton9").first();
    if (!(await button.count())) return false;

    await button.click();
    return true;
  } catch {
    return false;
  }
}

async function submitMicrosoftPassword(page, password) {
  try {
    const input = page.locator('#i0118, input[name="passwd"]').first();
    if (!(await input.count())) return false;

    await input.fill(password);

    const button = page.locator("#idSIButton9").first();
    if (!(await button.count())) return false;

    await button.click();
    return true;
  } catch {
    return false;
  }
}

async function selectMicrosoftAccount(page, username) {
  try {
    return await page.evaluate(wanted => {
      wanted = String(wanted || "").toLowerCase();

      const elements = [
        ...document.querySelectorAll('div[role="button"],button,a,[tabindex]')
      ];

      const account = elements.find(element =>
        String(element.innerText || element.textContent || "")
          .toLowerCase()
          .includes(wanted)
      );

      if (!account) return false;
      account.click();
      return true;
    }, username);
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

async function focusPageInfo(page) {
  try {
    return await page.evaluate(() => {
      const text = document.body ? document.body.innerText : "";
      const lower = String(text).toLowerCase();

      return {
        url: String(location.href || ""),
        loggedIn:
          text.includes("Log Out") &&
          !lower.includes("sign in with microsoft"),
        focusLogin: lower.includes("sign in with microsoft"),
        microsoftUsername: Boolean(
          document.querySelector('#i0116, input[name="loginfmt"]')
        ),
        microsoftPassword: Boolean(
          document.querySelector('#i0118, input[name="passwd"]')
        ),
        samlRequest: Boolean(
          document.querySelector('input[name="SAMLRequest"]')
        ),
        samlResponse: Boolean(
          document.querySelector('input[name="SAMLResponse"]')
        ),
        staySignedIn: lower.includes("stay signed in")
      };
    });
  } catch {
    return {
      url: page.url(),
      loggedIn: false,
      focusLogin: false,
      microsoftUsername: false,
      microsoftPassword: false,
      samlRequest: false,
      samlResponse: false,
      staySignedIn: false
    };
  }
}

async function openMicrosoftSSO(page) {
  try {
    const result = await page.evaluate(() => {
      const elements = [
        ...document.querySelectorAll('a,button,input,[role="button"]')
      ];

      const target = elements.find(element => {
        const text = String(
          element.innerText || element.value || element.textContent || ""
        ).toLowerCase();

        return text.includes("sign in with microsoft");
      });

      if (!target) {
        return { found: false, href: null };
      }

      const anchor = target.closest("a");

      return {
        found: true,
        href: target.href || anchor?.href || null
      };
    });

    if (!result.found) return false;

    if (result.href) {
      await gotoSafe(page, result.href);
      return true;
    }

    return await page.evaluate(() => {
      const target = [
        ...document.querySelectorAll('a,button,input,[role="button"]')
      ].find(element =>
        String(element.innerText || element.value || element.textContent || "")
          .toLowerCase()
          .includes("sign in with microsoft")
      );

      if (!target) return false;
      target.click();
      return true;
    });
  } catch {
    return false;
  }
}

// This intentionally follows the proven OG Scriptable state machine:
// one username/password/account/stay-signed-in pass, bounded SSO/SAML retries,
// and a GRADES_URL reload after each SAMLResponse.
async function automaticFocusLogin(page) {
  log("Starting OG-style Focus login.");

  await gotoSafe(page, GRADES_URL);

  let info = await focusPageInfo(page);
  if (info.loggedIn) return true;

  const deadline = Date.now() + 35000;

  let usernameDone = false;
  let passwordDone = false;
  let accountDone = false;
  let stayDone = false;
  let ssoAttempts = 0;
  let requestAttempts = 0;
  let responseAttempts = 0;

  while (Date.now() < deadline) {
    info = await focusPageInfo(page);

    log(`Focus auth host: ${hostFromURL(info.url)}`);

    if (info.loggedIn) {
      log("Focus authenticated.");
      return true;
    }

    if (info.focusLogin && ssoAttempts < 4) {
      ssoAttempts++;

      if (await openMicrosoftSSO(page)) {
        await sleep(500);
        continue;
      }
    }

    if (info.samlRequest && requestAttempts < 4) {
      requestAttempts++;
      log(`Submitting SAMLRequest ${requestAttempts}.`);
      await submitSAMLForm(page, "SAMLRequest");
      await sleep(500);
      continue;
    }

    if (info.microsoftUsername && !usernameDone) {
      usernameDone = true;
      log("Submitting Microsoft username.");
      await submitMicrosoftUsername(page, USERNAME);
      await sleep(700);
      continue;
    }

    if (info.microsoftPassword && !passwordDone) {
      passwordDone = true;
      log("Submitting Microsoft password.");
      await submitMicrosoftPassword(page, PASSWORD);
      await sleep(700);
      continue;
    }

    if (!accountDone) {
      const selected = await selectMicrosoftAccount(page, USERNAME);

      if (selected) {
        accountDone = true;
        log("Microsoft account selected.");
        await sleep(700);
        continue;
      }
    }

    if (info.staySignedIn && !stayDone) {
      stayDone = true;
      log("Accepting stay signed in.");
      await acceptStaySignedIn(page);
      await sleep(700);
      continue;
    }

    if (info.samlResponse && responseAttempts < 3) {
      responseAttempts++;
      log(`Submitting SAMLResponse ${responseAttempts}.`);

      await submitSAMLForm(page, "SAMLResponse");
      await sleep(1000);

      try {
        await gotoSafe(page, GRADES_URL);
      } catch {}

      continue;
    }

    await sleep(350);
  }

  try {
    await gotoSafe(page, GRADES_URL);
  } catch {}

  info = await focusPageInfo(page);
  return info.loggedIn;
}

async function scrapeGrades(page) {
  const schoolYear = currentSchoolYear();

  await gotoSafe(page, GRADES_URL);
  await sleep(900);

  const rows = await page.evaluate(year => {
    return [...document.querySelectorAll("tr")]
      .map(tr =>
        [...tr.querySelectorAll("th,td")].map(cell =>
          String(cell.innerText || "").trim()
        )
      )
      .filter(row => row.includes(year));
  }, schoolYear);

  const gradePattern = /^(?:NG|[0-9]{1,3}%\s*[A-F][+-]?|[A-F][+-]?)$/i;
  const courses = [];

  for (const row of rows) {
    const yi = row.indexOf(schoolYear);
    if (yi === -1) continue;

    const period = row[yi + 2] || "";
    const courseId = row[yi + 4] || "";
    const course = row[yi + 5] || "";
    const teacher = row[yi + 6] || "";

    if (!course) continue;

    const gradeTokens = row
      .slice(yi + 11)
      .filter(value => gradePattern.test(String(value).trim()));

    const latest = gradeTokens.length
      ? gradeTokens[gradeTokens.length - 1]
      : "NG";

    courses.push({
      key: courseId || `${period}-${course}`,
      period,
      course,
      teacher,
      latest,
      gradeTokens
    });
  }

  return { schoolYear, courses };
}

async function readDashboard() {
  try {
    return JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
  } catch {
    return {};
  }
}

function buildDashboardGrades(courses, oldData) {
  const oldByCourse = new Map(
    (Array.isArray(oldData.grades) ? oldData.grades : []).map(item => [
      String(item.course || ""),
      item
    ])
  );

  let changeCount = 0;

  const grades = courses.map(course => {
    const name = cleanCourseName(course.course);
    const parsed = gradeParts(course.latest);
    const old = oldByCourse.get(name);

    let change = "";

    if (old) {
      const oldPercent = old.percent ?? null;
      const oldLetter = String(old.letter || "NG");

      if (oldPercent !== parsed.percent || oldLetter !== parsed.letter) {
        change = "CHANGED";
        changeCount++;
      }
    } else {
      change = "NEW";
      changeCount++;
    }

    return {
      course: name,
      display: course.latest || "NG",
      percent: parsed.percent,
      letter: parsed.letter,
      change
    };
  });

  return { grades, changeCount };
}

async function writeDashboard(current) {
  const old = await readDashboard();
  const { grades, changeCount } = buildDashboardGrades(current.courses, old);

  const data = {
    dateLabel: dashboardDateLabel(),
    updatedAt: new Date().toISOString(),
    gradeStatus: changeCount
      ? `🚨 ${changeCount} change${changeCount === 1 ? "" : "s"}`
      : "Current grades",
    grades,
    assignments: Array.isArray(old.assignments) ? old.assignments : [],
    activityStatus: old.activityStatus || "Nothing new",
    activity: Array.isArray(old.activity) ? old.activity : [],
    message: old.message || ""
  };

  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");

  log(`Dashboard prepared: ${grades.length} courses, ${changeCount} changes.`);
}

async function writeSafeDebug(page, error) {
  try {
    const info = await focusPageInfo(page);
    const payload = {
      at: new Date().toISOString(),
      error: String(error),
      host: hostFromURL(page.url()),
      title: await page.title().catch(() => ""),
      state: {
        loggedIn: info.loggedIn,
        focusLogin: info.focusLogin,
        microsoftUsername: info.microsoftUsername,
        microsoftPassword: info.microsoftPassword,
        samlRequest: info.samlRequest,
        samlResponse: info.samlResponse,
        staySignedIn: info.staySignedIn
      }
    };

    await fs.writeFile(DEBUG_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  } catch {}
}

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage"]
});

const context = await browser.newContext({
  locale: "en-US",
  timezoneId: "America/New_York",
  viewport: { width: 1280, height: 900 }
});

const page = await context.newPage();

try {
  const success = await automaticFocusLogin(page);

  if (!success) {
    throw new Error("Focus login could not be completed by the unattended runner.");
  }

  const current = await scrapeGrades(page);

  if (!current.courses.length) {
    throw new Error("Focus login succeeded, but zero current-year courses were parsed.");
  }

  log(`Current-year courses parsed: ${current.courses.length}.`);

  await writeDashboard(current);

  await fs.rm(DEBUG_PATH, { force: true }).catch(() => {});

  log("Unattended Focus check completed successfully.");
} catch (error) {
  await writeSafeDebug(page, error);
  throw error;
} finally {
  await browser.close();
}

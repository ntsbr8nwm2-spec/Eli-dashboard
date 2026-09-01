import { chromium } from "playwright";
import fs from "node:fs/promises";

const GRADES_URL =
  "https://browardschools.focusschoolsoftware.com/focus/Modules.php?force_package=SIS&modname=Grades/StudentRCGrades.php&details=false";

const USERNAME = process.env.BCPS_USERNAME || "";
const PASSWORD = process.env.BCPS_PASSWORD || "";

const DATA_PATH = "data.json";
const DEBUG_PATH = "auth-debug.json";

if (!USERNAME || !PASSWORD) {
  throw new Error("BCPS_USERNAME or BCPS_PASSWORD secret is missing.");
}

const trace = [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(text) {
  console.log(`[SCHOOL] ${text}`);
}

function safeURLParts(value) {
  try {
    const url = new URL(value);
    return { host: url.hostname.toLowerCase(), path: url.pathname };
  } catch {
    return { host: "unknown", path: "" };
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

  return month >= 6 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
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
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
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
      if (!input?.form) return false;

      setTimeout(() => {
        HTMLFormElement.prototype.submit.call(input.form);
      }, 30);

      return true;
    }, fieldName);
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

async function pageInfo(page) {
  try {
    return await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const lower = text.toLowerCase();
      return {
        focusLogin: lower.includes("sign in with microsoft"),
        microsoftUsername: Boolean(document.querySelector('#i0116, input[name="loginfmt"]')),
        microsoftPassword: Boolean(document.querySelector('#i0118, input[name="passwd"]')),
        samlRequest: Boolean(document.querySelector('input[name="SAMLRequest"]')),
        samlResponse: Boolean(document.querySelector('input[name="SAMLResponse"]')),
        staySignedIn: lower.includes("stay signed in"),
        logoutText: text.includes("Log Out")
      };
    });
  } catch {
    return {
      focusLogin: false,
      microsoftUsername: false,
      microsoftPassword: false,
      samlRequest: false,
      samlResponse: false,
      staySignedIn: false,
      logoutText: false
    };
  }
}

async function openMicrosoftSSO(page) {
  try {
    const result = await page.evaluate(() => {
      const target = [...document.querySelectorAll('a,button,input,[role="button"]')]
        .find(element =>
          String(element.innerText || element.value || element.textContent || "")
            .toLowerCase()
            .includes("sign in with microsoft")
        );

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
        .find(element =>
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

async function inspectFrame(frame, schoolYear) {
  const url = safeURLParts(frame.url());
  try {
    const details = await frame.evaluate(year => {
      const text = document.body?.innerText || "";
      const lower = text.toLowerCase();
      const rows = [...document.querySelectorAll("tr")];
      const gradePattern = /^(?:NG|[0-9]{1,3}%\s*[A-F][+-]?|[A-F][+-]?)$/i;
      let authIssue = null;

      if (/(account or password is incorrect|password is incorrect|incorrect password|wrong password|password you entered is incorrect)/i.test(lower)) {
        authIssue = "invalid_password";
      } else if (/(couldn['’]?t find an account|could not find an account|account doesn['’]?t exist|account does not exist|username may be incorrect|enter a valid email address, phone number, or skype name)/i.test(lower)) {
        authIssue = "invalid_username";
      } else if (/(password has expired|password expired|change your password|update your password)/i.test(lower)) {
        authIssue = "password_expired";
      } else if (/(account has been locked|account is locked|temporarily locked|too many unsuccessful sign-in attempts|too many failed sign-in attempts)/i.test(lower)) {
        authIssue = "account_locked";
      } else if (/(approve sign[- ]?in request|enter (the )?code|verify your identity|two-step verification|authenticator app|use your phone to sign in|more information required|additional security verification)/i.test(lower)) {
        authIssue = "verification_required";
      } else if (/(sign[- ]?in is blocked|you can['’]?t sign in|you cannot sign in|account has been blocked)/i.test(lower)) {
        authIssue = "sign_in_blocked";
      }

      const shapes = rows
        .map(tr => [...tr.querySelectorAll("th,td")].map(cell => String(cell.innerText || "").trim()))
        .filter(cells => cells.includes(year))
        .slice(0, 8)
        .map(cells => ({
          cellCount: cells.length,
          yearIndex: cells.indexOf(year),
          nonEmptyIndexes: cells.map((v, i) => v ? i : -1).filter(i => i >= 0),
          gradeLikeIndexes: cells
            .map((v, i) => gradePattern.test(v) ? i : -1)
            .filter(i => i >= 0)
        }));

      const forms = [...document.forms].slice(0, 8).map(form => {
        let actionHost = "";
        let actionPath = "";
        try {
          const u = new URL(form.action || location.href);
          actionHost = u.hostname;
          actionPath = u.pathname;
        } catch {}
        return {
          actionHost,
          actionPath,
          inputNames: [...form.querySelectorAll("input")]
            .map(input => input.name)
            .filter(Boolean)
            .slice(0, 20)
        };
      });

      return {
        title: document.title || "",
        bodyLength: text.length,
        tableCount: document.querySelectorAll("table").length,
        rowCount: rows.length,
        yearRowCount: shapes.length,
        hasSchoolYear: text.includes(year),
        focusLogin: lower.includes("sign in with microsoft"),
        logoutText: text.includes("Log Out"),
        samlRequest: Boolean(document.querySelector('input[name="SAMLRequest"]')),
        samlResponse: Boolean(document.querySelector('input[name="SAMLResponse"]')),
        authIssue,
        rowShapes: shapes,
        forms
      };
    }, schoolYear);

    if (url.host !== "login.microsoftonline.com") details.authIssue = null;
    return { ...url, ...details };
  } catch (error) {
    return { ...url, inspectError: String(error).slice(0, 180) };
  }
}

async function snapshot(page, stage) {
  const schoolYear = currentSchoolYear();
  const frames = [];
  for (const frame of page.frames()) {
    frames.push(await inspectFrame(frame, schoolYear));
  }

  const shot = {
    stage,
    at: new Date().toISOString(),
    page: safeURLParts(page.url()),
    title: await page.title().catch(() => ""),
    frameCount: page.frames().length,
    frames
  };

  trace.push(shot);
  log(`Snapshot ${stage}: ${shot.page.host}${shot.page.path}, ${shot.frameCount} frame(s).`);
  return shot;
}

function parseCourseRows(rows, schoolYear) {
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

    const latest = gradeTokens.length ? gradeTokens[gradeTokens.length - 1] : "NG";

    courses.push({
      key: courseId || `${period}-${course}`,
      period,
      course,
      teacher,
      latest,
      gradeTokens
    });
  }

  return courses;
}

async function scrapeGradesFromCurrentDocumentTree(page) {
  const schoolYear = currentSchoolYear();

  for (const frame of page.frames()) {
    let rows = [];
    try {
      rows = await frame.evaluate(year =>
        [...document.querySelectorAll("tr")]
          .map(tr => [...tr.querySelectorAll("th,td")].map(cell => String(cell.innerText || "").trim()))
          .filter(row => row.includes(year)),
        schoolYear
      );
    } catch {}

    const courses = parseCourseRows(rows, schoolYear);
    if (courses.length) {
      log(`Parsed ${courses.length} courses from frame ${safeURLParts(frame.url()).host}.`);
      return { schoolYear, courses };
    }
  }

  return { schoolYear, courses: [] };
}

async function scrapeGrades(page, navigate = true) {
  if (navigate) {
    await gotoSafe(page, GRADES_URL);
    await sleep(1500);
  }

  for (let attempt = 1; attempt <= 8; attempt++) {
    const result = await scrapeGradesFromCurrentDocumentTree(page);
    if (result.courses.length) return result;
    await sleep(500);
  }

  return { schoolYear: currentSchoolYear(), courses: [] };
}

async function automaticFocusLogin(page) {
  log("Starting instrumented OG-style Focus login.");
  await gotoSafe(page, GRADES_URL);
  await snapshot(page, "initial");

  let usernameDone = false;
  let passwordDone = false;
  let accountDone = false;
  let stayDone = false;
  let ssoAttempts = 0;
  let requestAttempts = 0;
  let responseAttempts = 0;
  let lastUnknownFingerprint = "";

  const deadline = Date.now() + 45000;

  while (Date.now() < deadline) {
    const grades = await scrapeGrades(page, false);
    if (grades.courses.length) {
      log("Authentication proven by readable grade rows.");
      await snapshot(page, "grades-readable");
      return { success: true, grades };
    }

    const info = await pageInfo(page);
    const location = safeURLParts(page.url());

    if (info.focusLogin && ssoAttempts < 4) {
      ssoAttempts++;
      log(`Opening Microsoft SSO ${ssoAttempts}.`);
      if (await openMicrosoftSSO(page)) {
        await sleep(600);
        continue;
      }
    }

    if (info.samlRequest && requestAttempts < 4) {
      requestAttempts++;
      log(`Submitting SAMLRequest ${requestAttempts}.`);
      await snapshot(page, `before-saml-request-${requestAttempts}`);
      await submitSAMLForm(page, "SAMLRequest");
      await sleep(700);
      continue;
    }

    if (info.microsoftUsername && !usernameDone) {
      usernameDone = true;
      log("Submitting Microsoft username.");
      await submitMicrosoftUsername(page);
      await sleep(900);
      continue;
    }

    if (info.microsoftPassword && !passwordDone) {
      passwordDone = true;
      log("Submitting Microsoft password.");
      await submitMicrosoftPassword(page);
      await sleep(900);
      continue;
    }

    if (!accountDone) {
      const selected = await selectMicrosoftAccount(page);
      if (selected) {
        accountDone = true;
        log("Microsoft account selected.");
        await sleep(900);
        continue;
      }
    }

    if (info.staySignedIn && !stayDone) {
      stayDone = true;
      log("Accepting stay signed in.");
      await acceptStaySignedIn(page);
      await sleep(900);
      continue;
    }

    if (info.samlResponse && responseAttempts < 3) {
      responseAttempts++;
      log(`Submitting SAMLResponse ${responseAttempts}.`);
      await snapshot(page, `before-saml-response-${responseAttempts}`);
      await submitSAMLForm(page, "SAMLResponse");
      await sleep(1600);

      const afterResponse = await scrapeGrades(page, false);
      if (afterResponse.courses.length) {
        log("Grades became readable immediately after SAMLResponse.");
        await snapshot(page, `after-saml-response-${responseAttempts}-success`);
        return { success: true, grades: afterResponse };
      }

      await snapshot(page, `after-saml-response-${responseAttempts}`);
      await gotoSafe(page, GRADES_URL);
      await sleep(1200);
      continue;
    }

    const fingerprint = `${location.host}|${location.path}|${info.focusLogin}|${info.samlRequest}|${info.samlResponse}|${info.logoutText}`;
    if (fingerprint !== lastUnknownFingerprint) {
      lastUnknownFingerprint = fingerprint;
      await snapshot(page, "unhandled-state");
    }

    await sleep(500);
  }

  await snapshot(page, "deadline-before-final-reload");
  await gotoSafe(page, GRADES_URL);
  await sleep(1800);
  const grades = await scrapeGrades(page, false);
  await snapshot(page, grades.courses.length ? "final-reload-success" : "final-reload-failed");

  return {
    success: grades.courses.length > 0,
    grades,
    counters: { ssoAttempts, requestAttempts, responseAttempts }
  };
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
    (Array.isArray(oldData.grades) ? oldData.grades : []).map(item => [String(item.course || ""), item])
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
    gradeStatus: changeCount ? `🚨 ${changeCount} change${changeCount === 1 ? "" : "s"}` : "Current grades",
    grades,
    assignments: Array.isArray(old.assignments) ? old.assignments : [],
    activityStatus: old.activityStatus || "Nothing new",
    activity: Array.isArray(old.activity) ? old.activity : [],
    message: old.message || ""
  };

  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  log(`Dashboard prepared: ${grades.length} courses, ${changeCount} changes.`);
}

async function writeSafeDebug(page, error, loginResult = null) {
  try {
    if (!trace.length || trace.at(-1)?.stage !== "error-final") {
      await snapshot(page, "error-final");
    }

    const payload = {
      at: new Date().toISOString(),
      error: String(error),
      schoolYear: currentSchoolYear(),
      loginCounters: loginResult?.counters || null,
      trace
    };

    await fs.writeFile(DEBUG_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
    log(`Safe diagnostics written with ${trace.length} snapshots.`);
  } catch (debugError) {
    log(`Could not write diagnostics: ${String(debugError).slice(0, 160)}`);
  }
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
let loginResult = null;

try {
  loginResult = await automaticFocusLogin(page);

  if (!loginResult.success) {
    throw new Error("Focus login completed its auth flow, but no readable current-year grade rows were found.");
  }

  const current = loginResult.grades.courses.length
    ? loginResult.grades
    : await scrapeGrades(page, true);

  if (!current.courses.length) {
    throw new Error("Authentication was detected, but zero current-year courses were parsed.");
  }

  log(`Current-year courses parsed: ${current.courses.length}.`);
  await writeDashboard(current);
  await fs.rm(DEBUG_PATH, { force: true }).catch(() => {});
  log("Unattended Focus check completed successfully.");
} catch (error) {
  await writeSafeDebug(page, error, loginResult);
  throw error;
} finally {
  await browser.close();
}

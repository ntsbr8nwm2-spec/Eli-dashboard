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
const log = text => console.log(`[NEWS2] ${text}`);

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
    if (!text.includes("ERR_ABORTED") &&
        !text.includes("Navigation interrupted") &&
        !text.includes("interrupted by another navigation")) throw error;
  }
}

function currentSchoolYear() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit"
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
    return { host:"", focusLogin:false, microsoftUsername:false, microsoftPassword:false, samlRequest:false, samlResponse:false, staySignedIn:false };
  }
}

async function currentGradeRows(page) {
  const year = currentSchoolYear();
  for (const frame of page.frames()) {
    try {
      const text = await frame.locator("body").innerText({ timeout: 2500 });
      if (text.includes(year)) return true;
    } catch {}
  }
  return false;
}

async function automaticFocusLogin(page) {
  await gotoSafe(page, GRADES_URL);
  const deadline = Date.now() + 55000;
  let usernameDone=false, passwordDone=false, accountDone=false, stayDone=false;
  let ssoAttempts=0, requestAttempts=0, responseAttempts=0;

  while (Date.now() < deadline) {
    if (await currentGradeRows(page)) return true;
    const state = await pageState(page);
    log(`Auth host: ${state.host}`);

    if (state.focusLogin && ssoAttempts < 4) {
      ssoAttempts++;
      if (await openMicrosoftSSO(page)) { await sleep(700); continue; }
    }
    if (state.samlRequest && requestAttempts < 4) {
      requestAttempts++;
      await submitSAMLForm(page,"SAMLRequest"); await sleep(800); continue;
    }
    if (state.microsoftUsername && !usernameDone) {
      usernameDone=true; await submitMicrosoftUsername(page); await sleep(1000); continue;
    }
    if (state.microsoftPassword && !passwordDone) {
      passwordDone=true; await submitMicrosoftPassword(page); await sleep(1000); continue;
    }
    if (!accountDone && await selectMicrosoftAccount(page)) {
      accountDone=true; await sleep(1000); continue;
    }
    if (state.staySignedIn && !stayDone) {
      stayDone=true; await acceptStaySignedIn(page); await sleep(1000); continue;
    }
    if (state.samlResponse && responseAttempts < 4) {
      responseAttempts++;
      await submitSAMLForm(page,"SAMLResponse");
      await sleep(1700);
      if (await currentGradeRows(page)) return true;
      await gotoSafe(page,GRADES_URL); await sleep(1000); continue;
    }
    await sleep(500);
  }

  await gotoSafe(page,GRADES_URL).catch(()=>{});
  await sleep(1500);
  return await currentGradeRows(page);
}

async function openNewsTab(page) {
  await gotoSafe(page, FOCUS_PORTAL_URL);
  await sleep(1300);

  for (const frame of page.frames()) {
    try {
      const links = frame.getByText("News", { exact: true });
      const count = await links.count();
      if (!count) continue;
      await links.last().click({ timeout: 4000 });
      await sleep(2200);
      return true;
    } catch {}
  }

  for (const frame of page.frames()) {
    try {
      const result = await frame.evaluate(() => {
        let target = [...document.querySelectorAll('a,button,[role="tab"],[role="button"],div,span,li')]
          .find(el => String(el.innerText || el.textContent || "").trim().toLowerCase() === "news");
        target = target?.closest('a,button,[role="tab"],[role="button"]') || target;
        if (!target) return false;
        target.click();
        return true;
      });
      if (result) { await sleep(2200); return true; }
    } catch {}
  }
  return false;
}

const dateRe = /^\d{1,2}\/\d{1,2}$/;
const timeRe = /^\d{1,2}:\d{2}\s*(?:AM|PM)$/i;
const gradeRe = /^(?:A|A-|A\+|B|B-|B\+|C|C-|C\+|D|D-|D\+|F|EC|NG|--|—)$/i;
const percentRe = /^(?:1\d\d|\d{1,2})%$/;

function looksCourse(line) {
  const upper = String(line || "").toUpperCase();
  return /ANAT PHYSIO|BIOLOGY|AICE ENG|GEOMETRY|DIGITAL BUS|CHORUS|WORLD HIST|STUDY HALL|ENVIRONMENTAL|FRENCH|PREAICE/.test(upper);
}

function parseRenderedText(text) {
  const lines = String(text || "").split(/\n+/).map(x => x.replace(/\s+/g," ").trim()).filter(Boolean);
  const items = [];

  for (let i=0; i<lines.length; i++) {
    if (!dateRe.test(lines[i])) continue;

    let timeIndex = -1;
    for (let j=i+1; j<=Math.min(i+3,lines.length-1); j++) {
      if (timeRe.test(lines[j])) { timeIndex=j; break; }
    }
    if (timeIndex < 0) continue;

    let grade="", percent="";
    for (let j=Math.max(0,i-4); j<i; j++) {
      if (!grade && gradeRe.test(lines[j])) grade=lines[j].toUpperCase();
      if (!percent && percentRe.test(lines[j])) percent=lines[j];
    }

    const after=[];
    for (let j=timeIndex+1; j<Math.min(lines.length,timeIndex+10); j++) {
      if (dateRe.test(lines[j]) || timeRe.test(lines[j])) break;
      if (gradeRe.test(lines[j]) || percentRe.test(lines[j])) continue;
      if (/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i.test(lines[j])) break;
      after.push(lines[j]);
      if (after.length>=2 && looksCourse(after[after.length-1])) break;
    }

    let courseIndex = after.findIndex(looksCourse);
    if (courseIndex < 1) continue;
    const title = after.slice(0,courseIndex).join(" ").trim();
    const course = after[courseIndex].trim();
    if (!title || !course) continue;

    const date=lines[i];
    const time=lines[timeIndex].toUpperCase();
    const key=[date,time,course,title,grade,percent].join("|").toLowerCase();
    items.push({grade,percent,date,time,title,course,key});
  }

  const unique=[]; const seen=new Set();
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key); unique.push(item);
  }
  return { linesCount: lines.length, items: unique };
}

async function scrapeNews(page) {
  const all=[]; const diagnostics=[];
  for (const frame of page.frames()) {
    try {
      const text = await frame.locator("body").innerText({ timeout: 4000 });
      const parsed = parseRenderedText(text);
      diagnostics.push({
        url: (()=>{try{const u=new URL(frame.url());return `${u.hostname}${u.pathname}`;}catch{return "unknown";}})(),
        bodyLength:text.length,
        lineCount:parsed.linesCount,
        parsed:parsed.items.length
      });
      all.push(...parsed.items);
    } catch (error) {
      diagnostics.push({ url:"frame-read-failed", error:String(error).slice(0,180) });
    }
  }

  const unique=[]; const seen=new Set();
  for (const item of all) {
    if (seen.has(item.key)) continue;
    seen.add(item.key); unique.push(item);
  }
  return { items:unique, diagnostics };
}

function activityLine(item) {
  let title=item.title, points="";
  const match=title.match(/^(.*)\s+\(([^()]+)\)$/);
  if (match) { title=match[1].trim(); points=match[2].trim(); }
  const score=[points,item.percent,item.grade].filter(Boolean).join(" · ");
  return `${cleanCourseName(item.course)} — ${title}${score ? ` · ${score}` : ""} · ${item.date} ${item.time}`;
}

async function writeDebug(page, reason, diagnostics=[]) {
  const payload={
    at:new Date().toISOString(), reason,
    page:(()=>{try{const u=new URL(page.url());return{host:u.hostname,path:u.pathname};}catch{return{host:"unknown",path:""};}})(),
    diagnostics
  };
  await fs.writeFile(DEBUG_PATH,JSON.stringify(payload,null,2)+"\n","utf8");
}

const browser = await chromium.launch({ headless:true, args:["--disable-dev-shm-usage"] });
const context = await browser.newContext({ locale:"en-US", timezoneId:"America/New_York", viewport:{width:1280,height:900} });
const page = await context.newPage();

try {
  log("Logging into Focus.");
  if (!(await automaticFocusLogin(page))) throw new Error("Focus login failed for News collector.");
  if (!(await openNewsTab(page))) throw new Error("Focus News tab was not found.");

  const {items,diagnostics}=await scrapeNews(page);
  log(`Parsed ${items.length} Focus News rows.`);
  if (!items.length) {
    await writeDebug(page,"News page opened but zero assignment rows parsed.",diagnostics);
    throw new Error("Focus News opened but zero activity rows were parsed.");
  }

  const previousState=await readJSON(STATE_PATH,{});
  const oldSeen=new Set(Array.isArray(previousState.seenHashes)?previousState.seenHashes:[]);
  const hashed=items.map(item=>({item,hash:digest(item.key)}));
  const firstSuccessfulSync=!previousState.initialized;
  const newItems=firstSuccessfulSync?hashed:hashed.filter(entry=>!oldSeen.has(entry.hash));
  const recent=items.slice(0,15);

  const data=await readJSON(DATA_PATH,null);
  if (!data) throw new Error("data.json could not be read.");

  data.activityStatus=firstSuccessfulSync?`Loaded ${recent.length} recent`:newItems.length?`${newItems.length} new`:"Up to date";
  data.activity=recent.map(activityLine);
  data.updatedAt=new Date().toISOString();

  await fs.writeFile(DATA_PATH,JSON.stringify(data,null,2)+"\n","utf8");
  await fs.writeFile(STATE_PATH,JSON.stringify({
    initialized:true,
    seenHashes:[...new Set([...(previousState.seenHashes||[]),...hashed.map(entry=>entry.hash)])].slice(-1500),
    updatedAt:new Date().toISOString()
  },null,2)+"\n","utf8");

  await fs.rm(DEBUG_PATH,{force:true}).catch(()=>{});
  log(`Published ${recent.length} recent activity rows; ${newItems.length} new.`);
} catch (error) {
  await writeDebug(page,String(error)).catch(()=>{});
  throw error;
} finally {
  await browser.close();
}

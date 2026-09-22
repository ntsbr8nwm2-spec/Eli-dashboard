import { chromium } from "playwright";
import fs from "node:fs/promises";

const USERNAME = process.env.BCPS_USERNAME || "";
const PASSWORD = process.env.BCPS_PASSWORD || "";
const CLEVER_URL = "https://sso.browardschools.com/";
const CANVAS_CALENDAR = "https://browardschools.instructure.com/calendar";
const DATA_PATH = "data.json";
const DEBUG_PATH = "canvas-debug.json";
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WEEKDAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

if (!USERNAME || !PASSWORD) throw new Error("BCPS credentials are missing.");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = s => console.log(`[CANVAS] ${s}`);

function etParts() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(new Date());
  return {
    year:Number(parts.find(p=>p.type==="year")?.value),
    month:Number(parts.find(p=>p.type==="month")?.value),
    day:Number(parts.find(p=>p.type==="day")?.value)
  };
}
function todayKey(){const p=etParts();return `${p.year}-${String(p.month).padStart(2,"0")}-${String(p.day).padStart(2,"0")}`;}
function schoolYear(){const p=etParts();return p.month>=7?[p.year,p.year+1]:[p.year-1,p.year];}
function cleanCourse(v){const s=String(v||"").trim(),u=s.toUpperCase();if(u.includes("ANAT PHYSIO"))return"Anatomy";if(u.includes("BIOLOGY 1 HON"))return"Biology";if(u.includes("AICE ENG LANG"))return"English";if(u.includes("GEOMETRY"))return"Geometry";if(u.includes("DIGITAL BUS"))return"Digital Bus";if(u.includes("CHORUS"))return"Chorus";if(u.includes("AP WORLD HIST"))return"World Hist";if(u.includes("STUDY HALL"))return"Study Hall";return s||"Canvas";}
const DIRECTORY_URL="https://acperry.browardschools.com/directory-test";
const directoryEmailCache=new Map();
function validEmail(v){return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(String(v||"").trim());}
function focusTeacherParts(value){
  const raw=String(value||"").replace(/\s+/g," ").trim();
  if(!raw)return{last:"",initial:""};
  if(raw.includes(",")){
    const [lastPart,firstPart=""]=raw.split(",",2);
    return{
      last:lastPart.trim(),
      initial:(firstPart.trim().match(/[A-Za-z]/)||[""])[0].toLowerCase()
    };
  }
  const parts=raw.split(/\s+/).filter(Boolean);
  return{
    last:parts.slice(1).join(" ")||parts[0]||"",
    initial:(parts[0]||"").slice(0,1).toLowerCase()
  };
}
function teacherIdentityMatch(contactName,focusTeacher){
  const norm=s=>String(s||"").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g," ").trim();
  const c=norm(contactName);
  const parts=focusTeacherParts(focusTeacher);
  const last=norm(parts.last);
  if(!c||!last||!c.includes(last))return false;
  if(!parts.initial)return true;
  const firstWord=c.split(/\s+/)[0]||"";
  return firstWord.startsWith(parts.initial);
}
function focusTeacherLookupName(value){
  const parts=focusTeacherParts(value);
  if(!parts.last||/^tba\d*/i.test(parts.last))return"";
  return [parts.initial?parts.initial.toUpperCase():"",parts.last].filter(Boolean).join(" ");
}
function directoryNameParts(value){
  const name=String(value||"").replace(/\s+/g," ").trim();
  if(!name)return{first:"",last:""};
  if(name.includes(",")){
    const [lastPart,firstPart=""]=name.split(",",2);
    return{first:firstPart.trim().split(/\s+/)[0]||"",last:lastPart.trim()};
  }
  const parts=name.split(/\s+/).filter(Boolean);
  if(parts.length<2)return{first:"",last:parts[0]||""};
  const suffix=/^(?:jr\.?|sr\.?|ii|iii|iv)$/i.test(parts.at(-1)||"");
  return{first:parts[0],last:suffix?parts.slice(-2).join(" "):parts.at(-1)};
}
async function browardDirectoryEmail(name){
  const key=String(name||"").replace(/\s+/g," ").trim().toLowerCase();
  if(!key)return"";
  if(directoryEmailCache.has(key))return directoryEmailCache.get(key);
  let result="";
  try{
    const parts=directoryNameParts(name);
    const url=new URL(DIRECTORY_URL);
    url.searchParams.set("utf8","✓");
    url.searchParams.set("const_search_role_ids","1");
    url.searchParams.set("const_search_group_ids","");
    url.searchParams.set("const_search_keyword","");
    url.searchParams.set("const_search_first_name",parts.first);
    url.searchParams.set("const_search_last_name",parts.last);
    url.searchParams.set("const_search_department","");
    const response=await fetch(url,{headers:{"user-agent":"Mozilla/5.0 school-dashboard-contact-resolver"},signal:AbortSignal.timeout(8000)});
    if(response.ok){
      const html=await response.text();
      const emails=[...new Set((html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig)||[])
        .map(x=>x.trim())
        .filter(x=>/@(?:browardschools\.com|browardcountyschools\.onmicrosoft\.com)$/i.test(x)))];
      if(emails.length===1)result=emails[0];
      else if(emails.length>1){
        const first=String(parts.first||"").toLowerCase();
        const last=String(parts.last||"").replace(/\s+(?:jr\.?|sr\.?|ii|iii|iv)$/i,"").toLowerCase();
        const lower=html.toLowerCase();
        const matches=emails.filter(email=>{
          const idx=lower.indexOf(email.toLowerCase());
          if(idx<0)return false;
          const window=lower.slice(Math.max(0,idx-1600),Math.min(lower.length,idx+500));
          return (!first||window.includes(first))&&(!last||window.includes(last));
        });
        if(matches.length===1)result=matches[0];
      }
      console.log(`[DIRECTORY] ${name}: status=${response.status} bytes=${html.length} emails=${emails.length} resolved=${Boolean(result)}`);
    }else{
      console.log(`[DIRECTORY] ${name}: status=${response.status} resolved=false`);
    }
  }catch(error){
    console.log(`[DIRECTORY] ${name}: lookup failed (${String(error?.name||"error")})`);
  }
  directoryEmailCache.set(key,result);
  return result;
}

function directorySortKey(value){
  const parts=directoryNameParts(value);
  const norm=s=>String(s||"").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g," ").trim();
  return `${norm(parts.last)}|${norm(parts.first)}`;
}
function sameDirectoryPerson(a,b){
  const pa=directoryNameParts(a),pb=directoryNameParts(b);
  const norm=s=>String(s||"").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g," ").trim();
  const al=norm(pa.last),bl=norm(pb.last),af=norm(pa.first),bf=norm(pb.first);
  if(!al||!bl||al!==bl)return false;
  if(!af||!bf)return true;
  return af===bf||af.startsWith(bf)||bf.startsWith(af);
}
const directoryPageCache=new Map();
async function directoryEntries(page,pageNumber){
  if(directoryPageCache.has(pageNumber))return directoryPageCache.get(pageNumber);
  const url=`${DIRECTORY_URL}?const_page=${pageNumber}`;
  let entries=[];
  try{
    await gotoSafe(page,url,12000);
    await page.waitForFunction(
      () => /Email\s*:/i.test(document.body?.innerText||""),
      {timeout:6500}
    ).catch(()=>{});
    await sleep(500);
    entries=await page.evaluate(()=>{
      const clean=v=>String(v||"").replace(/\s+/g," ").trim();
      const emailRe=/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
      const allowed=e=>/@(?:browardschools\.com|browardcountyschools\.onmicrosoft\.com)$/i.test(String(e||"").trim());
      const out=[];

      // First choice: derive the person's name from the DOM around each published email link.
      for(const a of document.querySelectorAll('a[href^="mailto:"]')){
        const email=String(a.getAttribute("href")||"").replace(/^mailto:/i,"").split(/[?;]/)[0].trim();
        if(!allowed(email))continue;
        let name="";
        let box=a;
        for(let depth=0;box&&depth<9;depth++,box=box.parentElement){
          const named=box.querySelector?.('.fsFullName,[class*="FullName"],[class*="fullName"],h2,h3,h4,h5');
          const candidate=clean(named?.textContent||"");
          if(candidate&&!/^(Constituent|Directory Test)$/i.test(candidate)){name=candidate;break}
        }
        if(name)out.push({name,email});
      }

      // Finalsite sometimes renders the address as text instead of a mailto link.
      // Parse the visible lines around each email address in that case.
      if(!out.length){
        const lines=String(document.body?.innerText||"").split(/\n+/).map(clean).filter(Boolean);
        const label=/^(?:Email:?|Titles?:|Departments?:|Phone Numbers?:|School:?|Constituent|Image|previous page|next page|showing\b)/i;
        const looksName=value=>{
          if(!value||label.test(value)||emailRe.test(value))return false;
          if(/^\(?\d{3}\)?[\s\d-]{7,}$/.test(value))return false;
          if(value.length>90)return false;
          const words=value.split(/\s+/).filter(Boolean);
          return words.length>=2&&words.length<=8&&/[A-Za-z]/.test(value);
        };
        for(let i=0;i<lines.length;i++){
          const match=lines[i].match(emailRe);
          if(!match||!allowed(match[0]))continue;
          let name="";
          for(let j=i-1;j>=Math.max(0,i-12);j--){
            if(looksName(lines[j])){name=lines[j];break}
          }
          if(name)out.push({name,email:match[0]});
        }
      }

      const seen=new Set();
      return out.filter(x=>{
        const key=`${String(x.name||"").toLowerCase()}|${String(x.email||"").toLowerCase()}`;
        if(!x.name||!allowed(x.email)||seen.has(key))return false;
        seen.add(key);
        return true;
      });
    }).catch(()=>[]);
  }catch{}
  if(entries.length){
    console.log(`[DIRECTORY-PAGE] page=${pageNumber} entries=${entries.length} first=${entries[0]?.name||""} last=${entries.at(-1)?.name||""}`);
  }else{
    console.log(`[DIRECTORY-PAGE] page=${pageNumber} entries=0`);
  }
  directoryPageCache.set(pageNumber,entries);
  return entries;
}
async function browardDirectoryEmailBrowser(page,name){
  const cacheKey=`search:${String(name||"").toLowerCase().trim()}`;
  if(directoryEmailCache.has(cacheKey))return directoryEmailCache.get(cacheKey);

  const parts=directoryNameParts(name);
  let result="";
  try{
    const url=new URL(DIRECTORY_URL);
    url.searchParams.set("utf8","✓");
    url.searchParams.set("const_search_group_ids","");
    url.searchParams.set("const_search_role_ids","");
    url.searchParams.set("const_search_keyword","");
    url.searchParams.set("const_search_first_name",parts.first||"");
    url.searchParams.set("const_search_last_name",parts.last||"");
    url.searchParams.set("const_search_department","");
    url.searchParams.set("_lookup",String(Date.now()));

    await gotoSafe(page,url.toString(),15000);
    await page.waitForFunction(
      ({first,last})=>{
        const text=String(document.body?.innerText||"").toLowerCase();
        const f=String(first||"").toLowerCase();
        const l=String(last||"").toLowerCase();
        return (!f||text.includes(f))&&(!l||text.includes(l))&&text.includes("email");
      },
      {first:parts.first,last:parts.last},
      {timeout:9000}
    ).catch(()=>{});
    await sleep(700);

    const matches=await page.evaluate(({first,last})=>{
      const clean=v=>String(v||"").replace(/\s+/g," ").trim();
      const norm=v=>clean(v).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g," ").trim();
      const emailRe=/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
      const allowed=e=>/@(?:browardschools\.com|browardcountyschools\.onmicrosoft\.com)$/i.test(String(e||"").trim());
      const firstNorm=norm(first), lastNorm=norm(last);
      const out=[];

      const containers=[...document.querySelectorAll(
        '.fsConstituentItem,[class*="ConstituentItem"],[class*="constituentItem"],article,li'
      )];

      for(const box of containers){
        const text=clean(box.innerText||box.textContent||"");
        const low=norm(text);
        if(lastNorm&&!low.includes(lastNorm))continue;
        if(firstNorm&&!low.includes(firstNorm))continue;

        const emails=[];
        for(const a of box.querySelectorAll('a[href^="mailto:"]')){
          const e=String(a.getAttribute("href")||"").replace(/^mailto:/i,"").split(/[?;]/)[0].trim();
          if(allowed(e))emails.push(e);
        }
        for(const e of (text.match(emailRe)||[]))if(allowed(e))emails.push(e);

        const unique=[...new Set(emails)];
        if(unique.length)out.push(...unique);
      }

      if(!out.length){
        const body=String(document.body?.innerText||"");
        const lines=body.split(/\n+/).map(clean).filter(Boolean);
        for(let i=0;i<lines.length;i++){
          const lineNorm=norm(lines[i]);
          if(lastNorm&&!lineNorm.includes(lastNorm))continue;
          if(firstNorm&&!lineNorm.includes(firstNorm))continue;
          const window=lines.slice(i,Math.min(lines.length,i+12)).join(" ");
          for(const e of (window.match(emailRe)||[]))if(allowed(e))out.push(e);
        }
      }

      return [...new Set(out)];
    },{first:parts.first,last:parts.last}).catch(()=>[]);

    if(matches.length===1)result=matches[0];
    console.log(`[DIRECTORY-SEARCH] ${name}: matches=${matches.length} resolved=${Boolean(result)}`);
  }catch(error){
    console.log(`[DIRECTORY-SEARCH] ${name}: lookup failed (${String(error?.name||"error")})`);
  }

  directoryEmailCache.set(cacheKey,result);
  return result;
}
async function readJSON(path,fallback){try{return JSON.parse(await fs.readFile(path,"utf8"));}catch{return fallback;}}
async function gotoSafe(page,url,timeout=18000){try{await page.goto(url,{waitUntil:"domcontentloaded",timeout});}catch(e){const t=String(e||"");if(!t.includes("ERR_ABORTED")&&!t.includes("Navigation interrupted")&&!t.includes("interrupted by another navigation"))throw e;await sleep(900);}}
async function submitSAML(page,name){try{return await page.evaluate(n=>{const i=document.querySelector(`input[name="${n}"]`);if(!i?.form)return false;setTimeout(()=>HTMLFormElement.prototype.submit.call(i.form),30);return true;},name);}catch{return false;}}
async function msUser(page){try{const i=page.locator('#i0116,input[name="loginfmt"]').first();if(!(await i.count()))return false;await i.fill(USERNAME);await page.locator("#idSIButton9").first().click();return true;}catch{return false;}}
async function msPass(page){try{const i=page.locator('#i0118,input[name="passwd"]').first();if(!(await i.count()))return false;await i.fill(PASSWORD);await page.locator("#idSIButton9").first().click();return true;}catch{return false;}}
async function pickAccount(page){try{return await page.evaluate(w=>{w=String(w).toLowerCase();const e=[...document.querySelectorAll('div[role="button"],button,a,[tabindex]')].find(x=>String(x.innerText||x.textContent||"").toLowerCase().includes(w));if(!e)return false;e.click();return true;},USERNAME);}catch{return false;}}
async function staySignedIn(page){try{const b=page.locator("#idSIButton9").first();if(!(await b.count()))return false;await b.click();return true;}catch{return false;}}
async function clickAD(page){try{const r=await page.evaluate(()=>{const e=[...document.querySelectorAll('a,button,[role="button"]')].find(x=>String(x.innerText||x.textContent||"").toLowerCase().includes("log in with active directory"));return e?{ok:true,href:e.href||e.closest("a")?.href||null}:{ok:false,href:null};});if(!r.ok)return false;if(r.href)await gotoSafe(page,r.href);else await page.evaluate(()=>[...document.querySelectorAll('a,button,[role="button"]')].find(x=>String(x.innerText||x.textContent||"").toLowerCase().includes("log in with active directory"))?.click());return true;}catch{return false;}}
async function submitAD(page){try{const u=page.locator('#userNameInput,input[name="UserName"],input[name="username"]').first();const p=page.locator('#passwordInput,input[name="Password"],input[type="password"]').first();if(!(await u.count())||!(await p.count()))return false;await u.fill(USERNAME.split("@")[0]);await p.fill(PASSWORD);const b=page.locator('#submitButton,button[type="submit"],input[type="submit"]').first();if(await b.count())await b.click();return true;}catch{return false;}}
async function state(page){try{return await page.evaluate(()=>{const text=document.body?.innerText||"",l=text.toLowerCase(),h=String(location.hostname||"").toLowerCase();return{host:h,canvas:h==="browardschools.instructure.com",clever:h.includes("clever.com")&&(l.includes("resources")||l.includes("canvas")),adButton:l.includes("log in with active directory"),adForm:Boolean(document.querySelector('#userNameInput,input[name="UserName"],input[name="username"]'))&&Boolean(document.querySelector('#passwordInput,input[name="Password"],input[type="password"]')),msUser:Boolean(document.querySelector('#i0116,input[name="loginfmt"]')),msPass:Boolean(document.querySelector('#i0118,input[name="passwd"]')),request:Boolean(document.querySelector('input[name="SAMLRequest"]')),response:Boolean(document.querySelector('input[name="SAMLResponse"]')),stay:l.includes("stay signed in")};});}catch{return{};}}
async function openCanvasTile(page){try{const r=await page.evaluate(()=>{const low=v=>String(v||"").toLowerCase();const direct=[...document.querySelectorAll("a[href]")].find(a=>low(a.href).includes("browardschools.instructure.com")||low(a.href).includes("instructure.com/login/saml"));if(direct)return{ok:true,href:direct.href};let e=[...document.querySelectorAll("img,a,button,div,span")].find(x=>[x.innerText,x.textContent,x.getAttribute?.("aria-label"),x.getAttribute?.("title"),x.getAttribute?.("alt"),x.getAttribute?.("src")].some(v=>low(v).includes("canvas")));for(let i=0;e&&i<12;i++,e=e.parentElement){if(e.tagName==="A"&&e.href)return{ok:true,href:e.href};const a=e.querySelector?.("a[href]");if(a?.href)return{ok:true,href:a.href};}return{ok:false,href:null};});if(!r.ok)return false;await gotoSafe(page,r.href);return true;}catch{return false;}}
async function ensureCanvas(page){log("Opening Clever directly; skipping Focus completely.");await gotoSafe(page,CLEVER_URL).catch(()=>{});await sleep(1200);const end=Date.now()+65000;let ad=0,adLogin=0,mu=0,mp=0,acct=0,req=0,res=0,stay=0,tile=0;while(Date.now()<end){const s=await state(page);log(`Auth host: ${s.host||"unknown"}`);if(s.canvas){await sleep(2000);return true;}if(s.clever&&tile<6){tile++;if(await openCanvasTile(page)){await sleep(1800);continue;}}if(s.adButton&&ad<4){ad++;if(await clickAD(page)){await sleep(1000);continue;}}if(s.adForm&&adLogin<3){adLogin++;if(await submitAD(page)){await sleep(1500);continue;}}if(s.request&&req<4){req++;await submitSAML(page,"SAMLRequest");await sleep(700);continue;}if(s.msUser&&mu<3){mu++;await msUser(page);await sleep(900);continue;}if(s.msPass&&mp<3){mp++;await msPass(page);await sleep(900);continue;}if(acct<3&&await pickAccount(page)){acct++;await sleep(900);continue;}if(s.stay&&stay<2){stay++;await staySignedIn(page);await sleep(900);continue;}if(s.response&&res<4){res++;await submitSAML(page,"SAMLResponse");await sleep(1300);continue;}await sleep(450);}return false;}
async function openAgenda(page){for(let a=1;a<=3;a++){await gotoSafe(page,`${CANVAS_CALENDAR}#view_name=agenda&view_start=${todayKey()}`).catch(()=>{});await sleep(4200);const ok=await page.evaluate(()=>String(location.hostname||"").toLowerCase()==="browardschools.instructure.com"&&(document.body?.innerText||"").includes("Agenda")).catch(()=>false);if(ok)return true;if(a<3)await sleep(2200);}return false;}

async function canvasIdentityAndActivity(page){
  try{
    return await page.evaluate(async()=>{
      const clean=v=>String(v||"").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
      const norm=v=>clean(v)
        .toLowerCase()
        .replace(/^(?:assignment|quiz|discussion|graded|grade changed|score changed|submission|new grade)\s*[:\-–—,]?\s*/i,"")
        .replace(/[^a-z0-9]+/g," ")
        .trim();
      const getPage=async url=>{
        try{
          const r=await fetch(url,{credentials:"same-origin",headers:{"Accept":"application/json"}});
          if(!r.ok)return {data:null,next:""};
          const data=await r.json();
          const link=String(r.headers.get("Link")||"");
          const nextMatch=link.split(",").map(x=>x.trim()).find(x=>/rel="next"/i.test(x));
          const next=nextMatch?.match(/<([^>]+)>/)?.[1]||"";
          return {data,next};
        }catch{return {data:null,next:""};}
      };
      const get=async url=>(await getPage(url)).data;
      const getAll=async url=>{
        const out=[];
        const seen=new Set();
        let next=url;
        while(next&&!seen.has(next)){
          seen.add(next);
          const page=await getPage(next);
          if(Array.isArray(page.data))out.push(...page.data);
          else if(page.data!=null&&!out.length)return page.data;
          next=page.next;
        }
        return out;
      };
      const eventLabel=item=>{
        const type=clean(item?.type||"");
        const category=clean(item?.notification_category||"");
        const lowType=type.toLowerCase();
        const lowCategory=category.toLowerCase();
        if(lowCategory.includes("grading")||lowCategory.includes("grade"))return "Grading";
        if(lowCategory.includes("due"))return "Due date activity";
        if(lowType.includes("submission"))return "Submission";
        if(lowType.includes("announcement"))return "Announcement";
        if(lowType.includes("discussion"))return "Discussion";
        if(lowType.includes("conversation")||lowType.includes("message"))return "Message";
        if(lowType.includes("assignment"))return "Assignment activity";
        if(lowType.includes("quiz"))return "Quiz activity";
        if(category)return category;
        if(type)return type;
        return "Canvas activity";
      };
      const [profile,stream,courses]=await Promise.all([
        get("/api/v1/users/self/profile"),
        getAll("/api/v1/users/self/activity_stream?per_page=100"),
        getAll("/api/v1/courses?enrollment_state=active&include[]=term&per_page=100")
      ]);

      const nowDate=new Date();
      const schoolStartYear=nowDate.getMonth()>=6?nowDate.getFullYear():nowDate.getFullYear()-1;
      const schoolEndYear=schoolStartYear+1;
      const schoolStart=Date.parse(`${schoolStartYear}-07-01T00:00:00Z`);
      const schoolEnd=Date.parse(`${schoolEndYear}-07-01T00:00:00Z`);
      const courseCurrent=c=>{
        const label=clean(c?.name||c?.course_code||"");
        const ym=label.match(/\b(20\d{2})\s*[-–—/]\s*(20\d{2})\b/);
        if(ym)return Number(ym[1])===schoolStartYear&&Number(ym[2])===schoolEndYear;
        const startRaw=c?.term?.start_at||c?.start_at||"";
        const endRaw=c?.term?.end_at||c?.end_at||"";
        const startMs=startRaw?Date.parse(startRaw):NaN;
        const endMs=endRaw?Date.parse(endRaw):NaN;
        if(Number.isFinite(endMs)&&endMs<schoolStart)return false;
        if(Number.isFinite(startMs)&&startMs>=schoolEnd)return false;
        return true;
      };
      const activeCourses=Array.isArray(courses)?courses.filter(c=>c?.id!=null&&courseCurrent(c)):[];
      const allowedCourseIds=new Set(activeCourses.map(c=>String(c.id)));
      const accountIds=[...new Set(activeCourses.map(c=>c?.account_id).filter(id=>id!=null).map(String))];
      const accountNames={};
      for(const accountId of accountIds){
        const account=await get(`/api/v1/accounts/${encodeURIComponent(accountId)}`);
        const label=clean(account?.name||account?.default_time_zone||"");
        if(label)accountNames[accountId]=label;
      }
      const schoolCandidates=[...new Set(activeCourses.map(c=>accountNames[String(c?.account_id)]||"").filter(Boolean))];
      const schoolName=schoolCandidates.length===1?schoolCandidates[0]:"";
      const courseMap={};
      for(const c of activeCourses){
        const label=clean(c?.name||c?.course_code||"");
        if(label)courseMap[String(c.id)]=label;
      }

      const emailFrom=value=>{
        const match=String(value||"").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
        return match?match[0]:"";
      };
      const teacherGroups=await Promise.all(activeCourses.map(async c=>{
        const users=await getAll(`/api/v1/courses/${encodeURIComponent(c.id)}/users?enrollment_type[]=teacher&include[]=email&per_page=100`);
        const teachers=await Promise.all((Array.isArray(users)?users:[]).map(async u=>{
          let email=emailFrom(u?.email||u?.login_id||u?.sis_login_id||"");
          if(!email&&u?.id!=null){
            const profile=await get(`/api/v1/users/${encodeURIComponent(u.id)}/profile`);
            email=emailFrom(profile?.primary_email||profile?.email||profile?.login_id||profile?.sis_login_id||"");
          }
          return {
            id:u?.id!=null?String(u.id):"",
            name:clean(u?.name||u?.display_name||u?.sortable_name||u?.short_name||""),
            email
          };
        }));
        return {courseId:String(c.id),course:clean(courseMap[String(c.id)]||c?.name||c?.course_code||""),teachers:teachers.filter(t=>t.name||t.email)};
      }));
      const teacherContacts=teacherGroups.flatMap(group=>
        group.teachers.map(t=>({courseId:group.courseId,course:group.course,name:t.name,email:t.email}))
      );

      const name=clean(profile?.short_name||profile?.name||profile?.sortable_name||"");
      const firstName=clean(name.split(/\s+/)[0]||"").replace(/[^A-Za-zÀ-ÖØ-öø-ÿ'’-]/g,"").slice(0,40);

      const assignmentGroups=await Promise.all(activeCourses.map(async c=>{
        const list=await getAll(`/api/v1/courses/${encodeURIComponent(c.id)}/assignments?include[]=submission&per_page=100`);
        return {courseId:String(c.id),assignments:Array.isArray(list)?list:[]};
      }));

      const byId={};
      const byCourse={};
      const inventory=[];
      const fmt=n=>Number.isInteger(n)?String(n):String(Math.round(n*100)/100);
      const pct=n=>Number.isInteger(n)?String(n):String(Math.round(n*10)/10);

      for(const group of assignmentGroups){
        byCourse[group.courseId]=[];
        for(const a of group.assignments){
          if(!a?.id)continue;
          const rawAssignmentDates=[a.due_at,a.updated_at,a.created_at,a?.submission?.submitted_at,a?.submission?.graded_at,a?.submission?.updated_at].filter(Boolean);
          const assignmentDates=rawAssignmentDates.map(v=>Date.parse(v)).filter(Number.isFinite);
          if(assignmentDates.length&&!assignmentDates.some(ms=>ms>=schoolStart&&ms<schoolEnd))continue;
          const assignmentName=clean(a.name||"");
          const normalizedName=norm(assignmentName);
          const sub=a.submission||{};
          const gradeParts=[];
          if(sub.excused){
            gradeParts.push("Excused");
          }else{
            const hasScore=sub.score!==null&&sub.score!==undefined&&sub.score!=="";
            const score=hasScore?Number(sub.score):NaN;
            const possible=Number(a.points_possible);
            if(hasScore&&Number.isFinite(score)&&Number.isFinite(possible)&&possible>0){
              gradeParts.push(`${fmt(score)}/${fmt(possible)}`);
              gradeParts.push(`${pct((score/possible)*100)}%`);
            }else if(hasScore&&Number.isFinite(score)){
              gradeParts.push(`${fmt(score)} pts`);
            }
            const grade=clean(sub.grade||sub.entered_grade||"");
            if(grade){
              const compact=grade.toLowerCase().replace(/\s+/g,"");
              const already=gradeParts.some(x=>x.toLowerCase().replace(/\s+/g,"")===compact);
              if(!already)gradeParts.push(grade);
            }
          }
          const info={
            id:String(a.id),
            name:assignmentName,
            normalizedName,
            gradeText:gradeParts.join(" · "),
            course:clean(courseMap[group.courseId]||""),
            dueAt:a.due_at||"",
            submittedAt:sub.submitted_at||"",
            gradedAt:sub.graded_at||"",
            submissionUpdatedAt:sub.updated_at||"",
            updatedAt:a.updated_at||"",
            createdAt:a.created_at||"",
            workflowState:clean(sub.workflow_state||""),
            gradingType:clean(a.grading_type||""),
            published:a.published!==false,
            excused:Boolean(sub.excused),
            missing:Boolean(sub.missing),
            late:Boolean(sub.late),
            secondsLate:Number(sub.seconds_late)||0
          };
          byId[`${group.courseId}:${a.id}`]=info;
          byCourse[group.courseId].push(info);
          inventory.push(info);
        }
      }

      const courseStats=assignmentGroups.map(group=>{
        const rows=Array.isArray(group.assignments)?group.assignments:[];
        let submitted=0,graded=0,missing=0,withSubmission=0;
        for(const a of rows){
          const sub=a?.submission||null;
          if(sub){
            withSubmission++;
            const state=String(sub.workflow_state||"").toLowerCase();
            if(sub.submitted_at||state==="submitted"||state==="pending_review"||state==="graded")submitted++;
            if(state==="graded"||sub.graded_at||sub.score!==null&&sub.score!==undefined&&sub.score!=="")graded++;
            if(sub.missing)missing++;
          }
        }
        return {
          courseId:group.courseId,
          course:clean(courseMap[group.courseId]||""),
          assignments:rows.length,
          withSubmission,
          submitted,
          graded,
          missing
        };
      });

      const activity=[];
      const activityTimes={};
      if(Array.isArray(stream)){
        for(const item of stream){
          const rawTitle=clean(item?.title||item?.message||item?.notification_category||item?.type||"");
          if(!rawTitle)continue;
          const courseId=String(item?.course_id??"");
          if(courseId&&!allowedCourseIds.has(courseId))continue;
          const eventMs=item?.created_at?Date.parse(item.created_at):NaN;
          if(Number.isFinite(eventMs)&&(eventMs<schoolStart||eventMs>=schoolEnd))continue;
          const course=clean(courseMap[courseId]||item?.context_name||"");
          let assignmentId="";
          for(const candidate of [item?.assignment_id,item?.asset_id]){
            if(candidate!=null&&/^\d+$/.test(String(candidate))){assignmentId=String(candidate);break;}
          }
          if(!assignmentId&&item?.html_url){
            try{
              const u=new URL(item.html_url,location.origin);
              const m=u.pathname.match(/\/assignments\/(\d+)/i);
              if(m)assignmentId=m[1];
            }catch{}
          }

          let info=assignmentId?byId[`${courseId}:${assignmentId}`]:null;
          if(!info){
            const wanted=norm(rawTitle);
            const candidates=byCourse[courseId]||[];
            info=candidates.find(x=>x.normalizedName&&(
              x.normalizedName===wanted ||
              (x.normalizedName.length>=6&&wanted.includes(x.normalizedName)) ||
              (wanted.length>=6&&x.normalizedName.includes(wanted))
            ))||null;
          }

          const displayTitle=info?.name||rawTitle;
          const event=eventLabel(item);
          if(event==="Due date activity"||event==="Submission")continue;
          let when="";
          if(item?.created_at){
            const d=new Date(item.created_at);
            if(!Number.isNaN(d.getTime()))when=d.toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
          }
          const core=[course,displayTitle].filter(Boolean).join(" — ");
          const currentGrade=info?.gradeText?`Current grade: ${info.gradeText}`:"";
          const line=[core,event,currentGrade,when].filter(Boolean).join(" · ");
          if(line&&!activity.includes(line)){
            activity.push(line);
            activityTimes[line]=item?.created_at?(Date.parse(item.created_at)||0):0;
          }
        }
      }

      const now=Date.now();
      for(const info of inventory){
        const gradingType=String(info.gradingType||"").toLowerCase();
        const workflowState=String(info.workflowState||"").toLowerCase();
        if(!info.published||info.excused||gradingType==="not_graded")continue;

        if(info.gradeText){
          const rawDate=info.gradedAt||info.submittedAt||info.submissionUpdatedAt||info.updatedAt||info.dueAt||info.createdAt||"";
          const sortMs=rawDate?(Date.parse(rawDate)||0):0;
          let when="";
          if(rawDate){
            const d=new Date(rawDate);
            if(!Number.isNaN(d.getTime()))when=d.toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
          }
          const core=[info.course,info.name].filter(Boolean).join(" — ");
          const status=[];
          if(info.missing)status.push("Missing");
          if(info.late)status.push("Late");
          const line=[core,"Submission",...status,`Current grade: ${info.gradeText}`,when].filter(Boolean).join(" · ");
          if(line&&!activity.includes(line)){
            activity.push(line);
            activityTimes[line]=sortMs;
          }
          continue;
        }

        if(workflowState==="graded")continue;
        const dueMs=info.dueAt?Date.parse(info.dueAt):NaN;
        if(Number.isFinite(dueMs)&&dueMs>now)continue;
        const rawDate=info.dueAt||info.submittedAt||info.submissionUpdatedAt||info.updatedAt||info.createdAt||"";
        const sortMs=rawDate?(Date.parse(rawDate)||0):0;
        let when="";
        if(rawDate){
          const d=new Date(rawDate);
          if(!Number.isNaN(d.getTime()))when=d.toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
        }
        const core=[info.course,info.name].filter(Boolean).join(" — ");
        const submitted=Boolean(info.submittedAt)||workflowState==="submitted"||workflowState==="pending_review";
        let status="Not Submitted";
        if(info.missing)status="Missing";
        else if(submitted&&info.late)status="Submitted Late — Awaiting Grade";
        else if(submitted)status="Submitted — Awaiting Grade";
        else if(info.late)status="Late";
        else if(workflowState&&workflowState!=="unsubmitted")status=`Canvas status: ${workflowState}`;
        const line=[core,status,when].filter(Boolean).join(" · ");
        if(line&&!activity.includes(line)){
          activity.push(line);
          activityTimes[line]=sortMs;
        }
      }
      activity.sort((a,b)=>(activityTimes[b]||0)-(activityTimes[a]||0));
      return {firstName,activity,teacherContacts,schoolName,schoolCandidates,courseStats};
    });
  }catch{
    return {firstName:"",activity:[],teacherContacts:[],schoolName:"",schoolCandidates:[],courseStats:[]};
  }
}

function dateKey(mon,day){const m=MONTHS.findIndex(x=>x.toLowerCase()===String(mon).toLowerCase());if(m<0)return null;const [y1,y2]=schoolYear();return `${m>=6?y1:y2}-${String(m+1).padStart(2,"0")}-${String(Number(day)).padStart(2,"0")}`;}
function diffDays(a,b){const [ay,am,ad]=a.split("-").map(Number),[by,bm,bd]=b.split("-").map(Number);return Math.round((Date.UTC(ay,am-1,ad)-Date.UTC(by,bm-1,bd))/86400000);}
function dayLabel(k){const d=diffDays(k,todayKey());if(d===0)return"TODAY";if(d===1)return"TOMORROW";const [y,m,day]=k.split("-").map(Number);return `${WEEKDAYS[new Date(Date.UTC(y,m-1,day)).getUTCDay()].toUpperCase()} ${MONTHS[m-1].toUpperCase()} ${day}`;}
function parseAgenda(body){const clean=v=>String(v||"").replace(/\s+/g," ").trim();const lines=String(body||"").split(/\n+/).map(clean).filter(Boolean);const dateRe=/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat),\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\b/i,dueRe=/\bDue\s+(\d{1,2}:\d{2}\s*(?:am|pm))\b/i,statusRe=/\b(Not Completed|Completed|Submitted|Graded|Missing|Late)\b/i;const out=[];let date=null,p=null;const flush=()=>{if(!p)return;let t=p.parts.join(" ").replace(/\s+/g," ").trim();if(!t){p=null;return;}let title=t,course="",status="";const sm=t.match(statusRe);if(sm){status=sm[1];title=t.slice(0,sm.index).replace(/\s*,\s*$/,"").trim();course=t.slice(sm.index+sm[0].length).replace(/^Calendar\s+/i,"").trim();}else{const cm=t.match(/\s+Calendar\s+/i);if(cm){title=t.slice(0,cm.index).trim();course=t.slice(cm.index+cm[0].length).trim();}}title=title.replace(/^(Assignment|Quiz|Discussion)\s*,?\s*/i,"").trim();if(title)out.push({month:p.date.month,day:p.date.day,time:p.time,title,course,status,completed:["completed","submitted","graded"].includes(status.toLowerCase())});p=null;};for(const line of lines){const dm=line.match(dateRe);if(dm){flush();date={month:dm[2],day:Number(dm[3])};continue;}const due=line.match(dueRe);if(due&&date){flush();p={date,time:due[1],parts:[]};const rest=line.slice(due.index+due[0].length).replace(/^\s*,\s*/,"").trim();if(rest)p.parts.push(rest);continue;}if(p&&!["calendar","agenda","week","month","today","global navigation menu","create new event"].includes(line.toLowerCase()))p.parts.push(line);}flush();const seen=new Set();return out.filter(x=>{const k=[x.month,x.day,x.time,x.title,x.course,x.status].join("|").toLowerCase();if(seen.has(k))return false;seen.add(k);return true;});}

const browser=await chromium.launch({headless:true,args:["--disable-dev-shm-usage"]});
const context=await browser.newContext({locale:"en-US",timezoneId:"America/New_York",viewport:{width:1280,height:900}});
const page=await context.newPage();

try{
  if(!(await ensureCanvas(page)))throw new Error("Canvas authentication timed out.");
  const canvasMeta=await canvasIdentityAndActivity(page);
  if(canvasMeta.firstName)log(`Canvas identified student first name as ${canvasMeta.firstName}.`);
  if(Array.isArray(canvasMeta.courseStats)){
    for(const stat of canvasMeta.courseStats){
      log(`Canvas course stats: ${stat.course||stat.courseId} | assignments=${stat.assignments} submissions=${stat.submitted} graded=${stat.graded} missing=${stat.missing} submissionRecords=${stat.withSubmission}`);
    }
  }
  if(canvasMeta.schoolName)log(`Canvas school context: ${canvasMeta.schoolName}.`);
  else if(Array.isArray(canvasMeta.schoolCandidates)&&canvasMeta.schoolCandidates.length)log(`Canvas school candidates: ${canvasMeta.schoolCandidates.join(" | ")}.`);
  if(Array.isArray(canvasMeta.teacherContacts)&&canvasMeta.teacherContacts.some(contact=>!validEmail(contact?.email)&&contact?.name)){
    const directoryPage=await context.newPage();
    try{
      const uniqueNames=[...new Set(canvasMeta.teacherContacts.filter(contact=>!validEmail(contact?.email)&&contact?.name).map(contact=>String(contact.name).trim()))];
      const resolved=new Map();
      for(const name of uniqueNames){
        const email=await browardDirectoryEmailBrowser(directoryPage,name);
        if(validEmail(email))resolved.set(name.toLowerCase(),email);
      }
      for(const contact of canvasMeta.teacherContacts){
        if(!validEmail(contact?.email)&&contact?.name){
          const email=resolved.get(String(contact.name).trim().toLowerCase())||"";
          if(validEmail(email))contact.email=email;
        }
      }
    }finally{
      await directoryPage.close().catch(()=>{});
    }
  }
  if(!(await openAgenda(page)))throw new Error("Canvas Agenda did not load.");
  const body=await page.locator("body").innerText().catch(()=>"");
  const raw=parseAgenda(body);
  const upcoming=[];
  for(const x of raw){
    if(x.completed)continue;
    const k=dateKey(x.month,x.day);
    if(!k)continue;
    const d=diffDays(k,todayKey());
    if(d<0||d>7)continue;
    upcoming.push({...x,key:k});
  }
  upcoming.sort((a,b)=>a.key.localeCompare(b.key)||String(a.time).localeCompare(String(b.time)));
  const seenAssignments=new Set();
  const assignments=upcoming.map(x=>({
    day:dayLabel(x.key),
    time:String(x.time||"").trim().replace(/(\d)(am|pm)$/i,"$1 $2").toUpperCase(),
    course:cleanCourse(x.course),
    title:x.title
  })).filter(x=>{
    const key=[x.day,x.time,x.course,x.title].map(v=>String(v||"").trim().toLowerCase()).join("|");
    if(seenAssignments.has(key))return false;
    seenAssignments.add(key);
    return true;
  });
  const data=await readJSON(DATA_PATH,null);
  if(!data)throw new Error("data.json could not be read.");
  data.assignments=assignments;
  if(canvasMeta.firstName)data.studentName=canvasMeta.firstName;
  if(canvasMeta.schoolName)data.schoolName=canvasMeta.schoolName;
  if(Array.isArray(canvasMeta.schoolCandidates)&&canvasMeta.schoolCandidates.length)data.schoolCandidates=canvasMeta.schoolCandidates;
  if(Array.isArray(data.grades)&&Array.isArray(canvasMeta.teacherContacts)&&canvasMeta.teacherContacts.length){
    const normalizeCourse=value=>String(cleanCourse(value)||"").toLowerCase().replace(/\s+/g," ").trim();
    const emailOk=value=>validEmail(value);

    for(const grade of data.grades){
      const key=normalizeCourse(grade.course);
      const courseCandidates=canvasMeta.teacherContacts.filter(contact=>{
        const contactKey=normalizeCourse(contact.course);
        return contactKey===key||contactKey.startsWith(key+"-")||key.startsWith(contactKey+"-");
      });

      const identityCandidates=String(grade.teacher||"").trim()
        ? canvasMeta.teacherContacts.filter(contact=>teacherIdentityMatch(contact.name,grade.teacher))
        : [];

      let contact=null;

      const identityWithEmail=identityCandidates.filter(contact=>emailOk(contact.email));
      if(identityWithEmail.length===1){
        contact=identityWithEmail[0];
      }else{
        const courseIdentity=courseCandidates.filter(contact=>teacherIdentityMatch(contact.name,grade.teacher));
        const courseIdentityWithEmail=courseIdentity.filter(contact=>emailOk(contact.email));
        if(courseIdentityWithEmail.length===1)contact=courseIdentityWithEmail[0];
        else if(courseCandidates.length===1)contact=courseCandidates[0];
      }

      if(!contact&&!grade.teacher&&courseCandidates.length===1)contact=courseCandidates[0];
      if(!grade.teacher&&contact?.name)grade.teacher=String(contact.name).trim();
      if(!emailOk(grade.teacherEmail)&&emailOk(contact?.email))grade.teacherEmail=String(contact.email).trim();
    }

    const missingGrades=data.grades.filter(grade=>
      !emailOk(grade.teacherEmail)&&focusTeacherLookupName(grade.teacher)
    );

    if(missingGrades.length){
      const fallbackPage=await context.newPage();
      try{
        const cache=new Map();
        for(const grade of missingGrades){
          const lookup=focusTeacherLookupName(grade.teacher);
          if(!lookup)continue;
          let email=cache.get(lookup.toLowerCase());
          if(email===undefined){
            email=await browardDirectoryEmailBrowser(fallbackPage,lookup);
            cache.set(lookup.toLowerCase(),email||"");
          }
          if(emailOk(email))grade.teacherEmail=String(email).trim();
        }
      }finally{
        await fallbackPage.close().catch(()=>{});
      }
    }
  }
  if(canvasMeta.activity.length){
    data.activity=canvasMeta.activity;
    data.activityStatus="Canvas activity with full assignment history and submission status";
  }
  data.updatedAt=new Date().toISOString();
  await fs.writeFile(DATA_PATH,JSON.stringify(data,null,2)+"\n","utf8");
  await fs.rm(DEBUG_PATH,{force:true}).catch(()=>{});
  log(`Published ${assignments.length} upcoming Canvas assignments and ${canvasMeta.activity.length} Canvas activity items.`);
}catch(e){
  await fs.writeFile(DEBUG_PATH,JSON.stringify({at:new Date().toISOString(),reason:String(e),url:page.url()},null,2)+"\n","utf8").catch(()=>{});
  throw e;
}finally{
  await browser.close();
}
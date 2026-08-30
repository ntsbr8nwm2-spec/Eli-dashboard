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
      const get=async url=>{
        try{
          const r=await fetch(url,{credentials:"same-origin",headers:{"Accept":"application/json"}});
          if(!r.ok)return null;
          return await r.json();
        }catch{return null;}
      };
      const [profile,stream,courses]=await Promise.all([
        get("/api/v1/users/self/profile"),
        get("/api/v1/users/self/activity_stream?per_page=25"),
        get("/api/v1/courses?enrollment_state=active&per_page=100")
      ]);

      const activeCourses=Array.isArray(courses)?courses.filter(c=>c?.id!=null):[];
      const courseMap={};
      for(const c of activeCourses){
        const label=clean(c?.name||c?.course_code||"");
        if(label)courseMap[String(c.id)]=label;
      }

      const name=clean(profile?.short_name||profile?.name||profile?.sortable_name||"");
      const firstName=clean(name.split(/\s+/)[0]||"").replace(/[^A-Za-zÀ-ÖØ-öø-ÿ'’-]/g,"").slice(0,40);

      const assignmentGroups=await Promise.all(activeCourses.slice(0,20).map(async c=>{
        const list=await get(`/api/v1/courses/${encodeURIComponent(c.id)}/assignments?include[]=submission&per_page=100`);
        return {courseId:String(c.id),assignments:Array.isArray(list)?list:[]};
      }));

      const byId={};
      const byCourse={};
      const fmt=n=>Number.isInteger(n)?String(n):String(Math.round(n*100)/100);
      const pct=n=>Number.isInteger(n)?String(n):String(Math.round(n*10)/10);

      for(const group of assignmentGroups){
        byCourse[group.courseId]=[];
        for(const a of group.assignments){
          if(!a?.id)continue;
          const assignmentName=clean(a.name||"");
          const normalizedName=norm(assignmentName);
          const sub=a.submission||{};
          const gradeParts=[];
          if(sub.excused){
            gradeParts.push("Excused");
          }else{
            const score=Number(sub.score);
            const possible=Number(a.points_possible);
            if(Number.isFinite(score)&&Number.isFinite(possible)&&possible>0){
              gradeParts.push(`${fmt(score)}/${fmt(possible)}`);
              gradeParts.push(`${pct((score/possible)*100)}%`);
            }else if(Number.isFinite(score)){
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
            gradeText:gradeParts.join(" · ")
          };
          byId[`${group.courseId}:${a.id}`]=info;
          byCourse[group.courseId].push(info);
        }
      }

      const activity=[];
      if(Array.isArray(stream)){
        for(const item of stream){
          const rawTitle=clean(item?.title||item?.message||item?.notification_category||item?.type||"");
          if(!rawTitle)continue;
          const courseId=String(item?.course_id??"");
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
          let when="";
          if(item?.created_at){
            const d=new Date(item.created_at);
            if(!Number.isNaN(d.getTime()))when=d.toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
          }
          const core=[course,displayTitle].filter(Boolean).join(" — ");
          const line=[core,info?.gradeText||"",when].filter(Boolean).join(" · ");
          if(line&&!activity.includes(line))activity.push(line);
          if(activity.length>=15)break;
        }
      }
      return {firstName,activity};
    });
  }catch{
    return {firstName:"",activity:[]};
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
  const assignments=upcoming.map(x=>({
    day:dayLabel(x.key),
    time:String(x.time||"").trim().replace(/(\d)(am|pm)$/i,"$1 $2").toUpperCase(),
    course:cleanCourse(x.course),
    title:x.title
  }));
  const data=await readJSON(DATA_PATH,null);
  if(!data)throw new Error("data.json could not be read.");
  data.assignments=assignments;
  if(canvasMeta.firstName)data.studentName=canvasMeta.firstName;
  if(canvasMeta.activity.length){
    data.activity=canvasMeta.activity;
    data.activityStatus="Recent Canvas activity with grades";
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

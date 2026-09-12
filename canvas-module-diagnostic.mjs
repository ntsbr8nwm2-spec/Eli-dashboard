import { chromium } from "playwright";

const USERNAME = process.env.BCPS_USERNAME || "";
const PASSWORD = process.env.BCPS_PASSWORD || "";
const CLEVER_URL = "https://sso.browardschools.com/";

if (!USERNAME || !PASSWORD) throw new Error("BCPS credentials are missing.");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = s => console.log(`[CANVAS-DIAG] ${s}`);
async function gotoSafe(page,url,timeout=18000){try{await page.goto(url,{waitUntil:"domcontentloaded",timeout});}catch(e){const t=String(e||"");if(!t.includes("ERR_ABORTED")&&!t.includes("Navigation interrupted")&&!t.includes("interrupted by another navigation"))throw e;await sleep(900);}}
async function submitSAML(page,name){try{return await page.evaluate(n=>{const i=document.querySelector(`input[name="${n}"]`);if(!i?.form)return false;setTimeout(()=>HTMLFormElement.prototype.submit.call(i.form),30);return true;},name);}catch{return false;}}
async function msUser(page){try{const i=page.locator('#i0116,input[name="loginfmt"]').first();if(!(await i.count()))return false;await i.fill(USERNAME);await page.locator("#idSIButton9").first().click();return true;}catch{return false;}}
async function msPass(page){try{const i=page.locator('#i0118,input[name="passwd"]').first();if(!(await i.count()))return false;await i.fill(PASSWORD);await page.locator("#idSIButton9").first().click();return true;}catch{return false;}}
async function pickAccount(page){try{return await page.evaluate(w=>{w=String(w).toLowerCase();const e=[...document.querySelectorAll('div[role="button"],button,a,[tabindex]')].find(x=>String(x.innerText||x.textContent||"").toLowerCase().includes(w));if(!e)return false;e.click();return true;},USERNAME);}catch{return false;}}
async function staySignedIn(page){try{const b=page.locator("#idSIButton9").first();if(!(await b.count()))return false;await b.click();return true;}catch{return false;}}
async function clickAD(page){try{const r=await page.evaluate(()=>{const e=[...document.querySelectorAll('a,button,[role="button"]')].find(x=>String(x.innerText||x.textContent||"").toLowerCase().includes("log in with active directory"));if(!e)return{ok:false,href:null};return{ok:true,href:e.href||e.closest("a")?.href||null};});if(!r.ok)return false;if(r.href)await gotoSafe(page,r.href);else await page.evaluate(()=>[...document.querySelectorAll('a,button,[role="button"]')].find(x=>String(x.innerText||x.textContent||"").toLowerCase().includes("log in with active directory"))?.click());return true;}catch{return false;}}
async function submitAD(page){try{const u=page.locator('#userNameInput,input[name="UserName"],input[name="username"]').first();const p=page.locator('#passwordInput,input[name="Password"],input[type="password"]').first();if(!(await u.count())||!(await p.count()))return false;await u.fill(USERNAME.split("@")[0]);await p.fill(PASSWORD);const b=page.locator('#submitButton,button[type="submit"],input[type="submit"]').first();if(await b.count())await b.click();return true;}catch{return false;}}
async function state(page){try{return await page.evaluate(()=>{const text=document.body?.innerText||"",l=text.toLowerCase(),h=String(location.hostname||"").toLowerCase();return{host:h,canvas:h==="browardschools.instructure.com",clever:h.includes("clever.com")&&(l.includes("resources")||l.includes("canvas")),adButton:l.includes("log in with active directory"),adForm:Boolean(document.querySelector('#userNameInput,input[name="UserName"],input[name="username"]'))&&Boolean(document.querySelector('#passwordInput,input[name="Password"],input[type="password"]')),msUser:Boolean(document.querySelector('#i0116,input[name="loginfmt"]')),msPass:Boolean(document.querySelector('#i0118,input[name="passwd"]')),request:Boolean(document.querySelector('input[name="SAMLRequest"]')),response:Boolean(document.querySelector('input[name="SAMLResponse"]')),stay:l.includes("stay signed in")};});}catch{return{};}}
async function openCanvasTile(page){try{const r=await page.evaluate(()=>{const low=v=>String(v||"").toLowerCase();const direct=[...document.querySelectorAll("a[href]")].find(a=>low(a.href).includes("browardschools.instructure.com")||low(a.href).includes("instructure.com/login/saml"));if(direct)return{ok:true,href:direct.href};let e=[...document.querySelectorAll("img,a,button,div,span")].find(x=>[x.innerText,x.textContent,x.getAttribute?.("aria-label"),x.getAttribute?.("title"),x.getAttribute?.("alt"),x.getAttribute?.("src")].some(v=>low(v).includes("canvas")));for(let i=0;e&&i<12;i++,e=e.parentElement){if(e.tagName==="A"&&e.href)return{ok:true,href:e.href};const a=e.querySelector?.("a[href]");if(a?.href)return{ok:true,href:a.href};}return{ok:false,href:null};});if(!r.ok)return false;await gotoSafe(page,r.href);return true;}catch{return false;}}
async function ensureCanvas(page){await gotoSafe(page,CLEVER_URL).catch(()=>{});await sleep(1200);const end=Date.now()+65000;let ad=0,adLogin=0,mu=0,mp=0,acct=0,req=0,res=0,stay=0,tile=0;while(Date.now()<end){const s=await state(page);if(s.canvas){await sleep(1500);return true;}if(s.clever&&tile<6){tile++;if(await openCanvasTile(page)){await sleep(1800);continue;}}if(s.adButton&&ad<4){ad++;if(await clickAD(page)){await sleep(1000);continue;}}if(s.adForm&&adLogin<3){adLogin++;if(await submitAD(page)){await sleep(1500);continue;}}if(s.request&&req<4){req++;await submitSAML(page,"SAMLRequest");await sleep(700);continue;}if(s.msUser&&mu<3){mu++;await msUser(page);await sleep(900);continue;}if(s.msPass&&mp<3){mp++;await msPass(page);await sleep(900);continue;}if(acct<3&&await pickAccount(page)){acct++;await sleep(900);continue;}if(s.stay&&stay<2){stay++;await staySignedIn(page);await sleep(900);continue;}if(s.response&&res<4){res++;await submitSAML(page,"SAMLResponse");await sleep(1300);continue;}await sleep(450);}return false;}

const browser=await chromium.launch({headless:true,args:["--disable-dev-shm-usage"]});
const context=await browser.newContext({locale:"en-US",timezoneId:"America/New_York"});
const page=await context.newPage();
try{
  if(!(await ensureCanvas(page))) throw new Error("Canvas authentication timed out.");
  const result=await page.evaluate(async()=>{
    const clean=v=>String(v||"").replace(/<[^>]*>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/\s+/g," ").trim();
    const termRe=/gumm|osmos|bear|diffus|membrane/i;
    const snippet=v=>{const raw=clean(v);const m=raw.search(termRe);if(m<0)return raw.slice(0,260);return raw.slice(Math.max(0,m-120),m+260);};
    const getPage=async url=>{try{const r=await fetch(url,{credentials:"same-origin",headers:{Accept:"application/json"}});if(!r.ok)return{data:null,next:""};const data=await r.json();const link=String(r.headers.get("Link")||"");const nextMatch=link.split(",").map(x=>x.trim()).find(x=>/rel="next"/i.test(x));return{data,next:nextMatch?.match(/<([^>]+)>/)?.[1]||""};}catch{return{data:null,next:""};}};
    const get=async url=>(await getPage(url)).data;
    const getAll=async url=>{const out=[],seen=new Set();let next=url;while(next&&!seen.has(next)){seen.add(next);const p=await getPage(next);if(Array.isArray(p.data))out.push(...p.data);else if(p.data!=null&&!out.length)return p.data;next=p.next;}return out;};
    const now=new Date();const sy=now.getMonth()>=6?now.getFullYear():now.getFullYear()-1, ey=sy+1;const schoolStart=Date.parse(`${sy}-07-01T00:00:00Z`),schoolEnd=Date.parse(`${ey}-07-01T00:00:00Z`);
    const current=c=>{const label=clean(c?.name||c?.course_code||"");const ym=label.match(/\b(20\d{2})\s*[-–—/]\s*(20\d{2})\b/);if(ym)return Number(ym[1])===sy&&Number(ym[2])===ey;const s=Date.parse(c?.term?.start_at||c?.start_at||""),e=Date.parse(c?.term?.end_at||c?.end_at||"");if(Number.isFinite(e)&&e<schoolStart)return false;if(Number.isFinite(s)&&s>=schoolEnd)return false;return true;};
    const courses=(await getAll('/api/v1/courses?enrollment_state=active&include[]=term&per_page=100')).filter(c=>c?.id!=null&&current(c));
    const rows=[];
    for(const c of courses){
      const course=clean(c.name||c.course_code||"");
      const assignments=await getAll(`/api/v1/courses/${c.id}/assignments?include[]=submission&per_page=100`);
      for(const a of assignments){
        const title=clean(a?.name||"");
        const desc=String(a?.description||"");
        if(termRe.test(`${title} ${desc}`)) rows.push({source:'assignment',course,title,published:a?.published!==false,grading_type:a?.grading_type||'',due_at:a?.due_at||'',points_possible:a?.points_possible??null,matched_in:termRe.test(title)?'title':'description',snippet:snippet(desc||title),submission:{workflow_state:a?.submission?.workflow_state||'',submitted_at:a?.submission?.submitted_at||'',missing:Boolean(a?.submission?.missing),late:Boolean(a?.submission?.late),grade:a?.submission?.grade??null,score:a?.submission?.score??null}});
      }
      if(!/LIFE SCIENCE|SCIENCE/i.test(course)) continue;
      const modules=await getAll(`/api/v1/courses/${c.id}/modules?per_page=100`);
      for(const m of modules){
        const items=await getAll(`/api/v1/courses/${c.id}/modules/${m.id}/items?per_page=100`);
        for(const item of items){
          const title=clean(item?.title||"");
          let detail=null;
          if(item?.url) detail=await get(item.url);
          const body=String(detail?.body||detail?.description||"");
          const hay=`${title} ${body}`;
          if(termRe.test(hay)) rows.push({source:'module_content',course,module:clean(m?.name||''),title,type:item?.type||'',page_url:item?.page_url||'',api_url:item?.url||'',html_url:item?.html_url||'',matched_in:termRe.test(title)?'title':'body',snippet:snippet(body||title)});
        }
      }
    }
    return rows;
  });
  log(`MATCHES ${JSON.stringify(result)}`);
} finally {
  await browser.close();
}

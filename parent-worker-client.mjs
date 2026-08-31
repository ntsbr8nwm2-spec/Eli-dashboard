// Secure client used by the GitHub-hosted parent dashboard worker.
import fs from 'node:fs/promises';

const SUPABASE_URL='https://vihtghmtnnozflnmecis.supabase.co';
const WORKER_URL=`${SUPABASE_URL}/functions/v1/school-worker`;
const MODE=process.argv[2]||'';
const WORKDIR=process.env.PARENT_WORKDIR||'/tmp/parent-school-run';

async function oidcToken(){
  const base=process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const reqToken=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if(!base||!reqToken) throw new Error('GitHub OIDC is unavailable.');
  const u=new URL(base);
  u.searchParams.set('audience','broward-parent-worker');
  const r=await fetch(u,{headers:{Authorization:`Bearer ${reqToken}`}});
  if(!r.ok) throw new Error(`OIDC request failed (${r.status})`);
  const j=await r.json();
  if(!j.value) throw new Error('OIDC token missing.');
  return j.value;
}

async function callWorker(body){
  let lastError;
  for(let attempt=1;attempt<=2;attempt++){
    try{
      const token=await oidcToken();
      const r=await fetch(WORKER_URL,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
      const text=await r.text();
      let data={}; try{data=JSON.parse(text)}catch{}
      if(r.ok) return data;
      const err=new Error(data.error||`Worker backend failed (${r.status})`);
      err.status=r.status;
      throw err;
    }catch(e){
      lastError=e;
      if(attempt===2 || ![401,502,503,504].includes(Number(e?.status||0))) break;
      await new Promise(r=>setTimeout(r,700));
    }
  }
  throw lastError;
}

async function appendEnv(name,value){
  const p=process.env.GITHUB_ENV;
  if(!p) return;
  const marker=`EOF_${Math.random().toString(36).slice(2)}`;
  await fs.appendFile(p,`${name}<<${marker}\n${String(value??'')}\n${marker}\n`);
}

function scrub(value){
  let text=String(value||'');
  for(const secret of [process.env.BCPS_USERNAME,process.env.BCPS_PASSWORD]){
    if(secret) text=text.split(secret).join('[redacted]');
  }
  text=text.replace(/https?:\/\/\S+/gi,'[url]');
  text=text.replace(/[A-Za-z0-9_\-.]{40,}/g,'[redacted]');
  return text.replace(/\s+/g,' ').trim().slice(0,320);
}

async function lease(){
  const {job}=await callWorker({action:'lease'});
  await fs.mkdir(WORKDIR,{recursive:true});
  if(!job){
    await appendEnv('NO_PARENT_JOB','true');
    console.log('[PARENT] No connected student is waiting for a run.');
    return;
  }
  console.log(`::add-mask::${job.school_username}`);
  console.log(`::add-mask::${job.school_password}`);
  await appendEnv('NO_PARENT_JOB','false');
  await appendEnv('STUDENT_ID',job.student_id);
  await appendEnv('STUDENT_FIRST_NAME',job.first_name||'Student');
  await appendEnv('BCPS_USERNAME',job.school_username);
  await appendEnv('BCPS_PASSWORD',job.school_password);
  await appendEnv('SCHOOL_LOGIN_METHOD',job.login_method||'student_sso');
  const initial={dateLabel:'Latest school update',updatedAt:new Date().toISOString(),gradeStatus:'Current grades',grades:[],assignments:[],activityStatus:'Nothing new',activity:[]};
  const data=job.dashboard_data&&Object.keys(job.dashboard_data).length?job.dashboard_data:initial;
  await fs.writeFile(`${WORKDIR}/data.json`,JSON.stringify(data,null,2)+'\n');
  await fs.writeFile(`${WORKDIR}/news-state.json`,JSON.stringify(job.news_state||{},null,2)+'\n');
  await fs.writeFile(`${WORKDIR}/canvas-state.json`,JSON.stringify(job.canvas_state||{},null,2)+'\n');
  console.log(`[PARENT] Leased dashboard job for ${job.first_name||'student'} using ${job.login_method||'student_sso'}.`);
}

async function publish(){
  const studentId=process.env.STUDENT_ID;
  if(!studentId) throw new Error('STUDENT_ID missing.');
  const read=async(name,fallback)=>{try{return JSON.parse(await fs.readFile(`${WORKDIR}/${name}`,'utf8'))}catch{return fallback}};
  const data=await read('data.json',{});
  const news=await read('news-state.json',{});
  const canvas=await read('canvas-state.json',{});
  await callWorker({action:'publish',student_id:studentId,data,news_state:news,canvas_state:canvas});
  console.log('[PARENT] Private dashboard published to Supabase.');
}

async function fail(){
  const studentId=process.env.STUDENT_ID;
  if(!studentId) return;
  let error=String(process.env.WORKER_ERROR||'School monitor failed');
  try{
    const stderr=await fs.readFile(`${WORKDIR}/grade-stderr.txt`,'utf8');
    if(stderr.trim()) error+=`; stderr=${scrub(stderr)}`;
  }catch{}
  try{
    const auth=JSON.parse(await fs.readFile(`${WORKDIR}/auth-debug.json`,'utf8'));
    if(auth?.error) error+=`; auth=${scrub(auth.error)}`;
    const last=Array.isArray(auth?.trace)?auth.trace.at(-1):null;
    if(last?.page?.host) error+=`; page=${scrub(`${last.page.host}${last.page.path||''}`)}`;
  }catch{}
  try{
    const parent=JSON.parse(await fs.readFile(`${WORKDIR}/parent-focus-debug.json`,'utf8'));
    if(parent?.error) error+=`; parent=${scrub(parent.error)}`;
    if(parent?.page?.host) error+=`; page=${scrub(`${parent.page.host}${parent.page.path||''}`)}`;
    if(parent?.diag?.host) error+=`; page=${scrub(`${parent.diag.host}${parent.diag.path||''}`)}`;
  }catch{}
  error=scrub(error).slice(0,500);
  await callWorker({action:'fail',student_id:studentId,error});
  console.log('[PARENT] Worker failure recorded without exposing school credentials.');
}

if(MODE==='lease') await lease();
else if(MODE==='publish') await publish();
else if(MODE==='fail') await fail();
else throw new Error('Use lease, publish, or fail.');

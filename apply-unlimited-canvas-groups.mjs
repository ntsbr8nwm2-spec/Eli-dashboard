import fs from 'node:fs/promises';

function replaceOnce(src, pattern, replacement, label) {
  const next = src.replace(pattern, replacement);
  if (next === src) throw new Error(`Patch target not found: ${label}`);
  return next;
}

// -----------------------------------------------------------------------------
// Collector: remove artificial caps, paginate Canvas APIs, and build submissions
// from the full assignment inventory.
// -----------------------------------------------------------------------------
const collectorPath = 'canvas-only.mjs';
let collector = await fs.readFile(collectorPath, 'utf8');

collector = replaceOnce(
  collector,
  /      const get=async url=>\{[\s\S]*?\n      \};\n      const eventLabel=/,
`      const getPage=async url=>{
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
      const eventLabel=`,
  'paginated fetch helper'
);

collector = replaceOnce(
  collector,
`      const [profile,stream,courses]=await Promise.all([
        get("/api/v1/users/self/profile"),
        get("/api/v1/users/self/activity_stream?per_page=25"),
        get("/api/v1/courses?enrollment_state=active&per_page=100")
      ]);`,
`      const [profile,stream,courses]=await Promise.all([
        get("/api/v1/users/self/profile"),
        getAll("/api/v1/users/self/activity_stream?per_page=100"),
        getAll("/api/v1/courses?enrollment_state=active&per_page=100")
      ]);`,
  'full activity and course pagination'
);

collector = replaceOnce(
  collector,
`      const assignmentGroups=await Promise.all(activeCourses.slice(0,20).map(async c=>{
        const list=await get(\`/api/v1/courses/\${encodeURIComponent(c.id)}/assignments?include[]=submission&per_page=100\`);
        return {courseId:String(c.id),assignments:Array.isArray(list)?list:[]};
      }));`,
`      const assignmentGroups=await Promise.all(activeCourses.map(async c=>{
        const list=await getAll(\`/api/v1/courses/\${encodeURIComponent(c.id)}/assignments?include[]=submission&per_page=100\`);
        return {courseId:String(c.id),assignments:Array.isArray(list)?list:[]};
      }));`,
  'all courses and assignment pages'
);

collector = replaceOnce(
  collector,
`            dueAt:a.due_at||"",
            submittedAt:sub.submitted_at||"",
            updatedAt:a.updated_at||"",`,
`            dueAt:a.due_at||"",
            submittedAt:sub.submitted_at||"",
            gradedAt:sub.graded_at||"",
            submissionUpdatedAt:sub.updated_at||"",
            updatedAt:a.updated_at||"",`,
  'submission timestamps'
);

collector = collector.replace('      let recentCount=0;\n','');
collector = collector.replace('            recentCount++;\n','');
collector = collector.replace('          if(recentCount>=15)break;\n','');

collector = replaceOnce(
  collector,
`          if(event==="Due date activity")continue;`,
`          if(event==="Due date activity"||event==="Submission")continue;`,
  'stream submission dedupe'
);

collector = replaceOnce(
  collector,
  /      const now=Date\.now\(\);\n      for\(const info of inventory\)\{[\s\S]*?\n      \}\n      activity\.sort/,
`      const now=Date.now();
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
          const line=[core,"Submission",\`Current grade: \${info.gradeText}\`,when].filter(Boolean).join(" · ");
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
        const line=[core,"Not graded yet",when].filter(Boolean).join(" · ");
        if(line&&!activity.includes(line)){
          activity.push(line);
          activityTimes[line]=sortMs;
        }
      }
      activity.sort`,
  'full inventory submissions and ungraded work'
);

collector = collector.replaceAll(
  'Recent Canvas activity with event type and current grades',
  'Canvas activity with full assignment history'
);

await fs.writeFile(collectorPath, collector, 'utf8');

// -----------------------------------------------------------------------------
// Frontend: category -> class -> items. Class headers are visually distinct.
// -----------------------------------------------------------------------------
const parentPath = 'parent/index.html';
let parent = await fs.readFile(parentPath, 'utf8');

parent = replaceOnce(
  parent,
  /\.activityGroup\{margin-top:18px\}\.activityGroup:first-child\{margin-top:0\}\.activityGroupTitle\{([^}]*)\}\.activity\{/,
  `.activityGroup{margin-top:20px}.activityGroup:first-child{margin-top:0}.activityGroupTitle{$1}.activityCourseGroup{margin:11px 0 17px}.activityCourseTitle{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 7px;padding:8px 10px;border-left:4px solid #24669d;border-radius:9px;background:#eef5fb;color:#173f66;font-size:12.5px;font-weight:950;letter-spacing:.35px}.activityCourseCount{font-size:10px;color:#60778e;font-weight:850}.activity{`,
  'class grouping styles'
);

parent = replaceOnce(
  parent,
  /function activityCategory\(line\)\{[^\n]*\}\nfunction failingSubmission/,
`function activityCategory(line){const s=String(line||'');const types=[['Submission','Submissions'],['Not graded yet','Not Graded Yet'],['Due date activity','Not Graded Yet'],['Grading','Grading'],['Quiz activity','Quiz activity'],['Assignment activity','Assignment activity'],['Discussion','Discussions'],['Message','Messages'],['Announcement','Announcements'],['Canvas activity','Other Canvas activity']];for(const [label,group] of types){if(s.includes(\` · \${label} · \`)||s.endsWith(\` · \${label}\`))return group}if(s.includes('Current grade:'))return'Submissions';return'Other activity'}
function activityCourse(line){const s=String(line||'');const i=s.indexOf(' — ');return i>0?s.slice(0,i).trim():'Other'}
function activityDetail(line){const s=String(line||'');const i=s.indexOf(' — ');return i>0?s.slice(i+3).trim():s}
function failingSubmission`,
  'activity classification and class helpers'
);

parent = replaceOnce(
  parent,
  /function renderActivity\(activity\)\{[^\n]*\}\nfunction render\(/,
`function renderActivity(activity){if(!activity.length)return'<div class="empty">Nothing new</div>';const order=['Submissions','Not Graded Yet','Grading','Quiz activity','Assignment activity','Discussions','Messages','Other Canvas activity','Other activity','Announcements'];const groups={};for(const item of activity){const group=activityCategory(item);(groups[group]??=[]).push(item)}return order.filter(group=>groups[group]?.length).map(group=>{const classes={};for(const item of groups[group]){const course=activityCourse(item);(classes[course]??=[]).push(item)}const classHtml=Object.entries(classes).map(([course,items])=>\`<div class="activityCourseGroup"><div class="activityCourseTitle"><span>\${esc(course)}</span><span class="activityCourseCount">\${items.length}</span></div>\${items.map(item=>\`<div class="activity \${failingSubmission(item)?'alert':''}">\${esc(activityDetail(item))}</div>\`).join('')}</div>\`).join('');return \`<div class="activityGroup"><div class="activityGroupTitle">\${esc(group)} · \${groups[group].length}</div>\${classHtml}</div>\`}).join('')}
function render(`,
  'category and class grouped rendering'
);

parent = parent.replaceAll("'Recent Canvas activity'","'Canvas activity'");
await fs.writeFile(parentPath, parent, 'utf8');

console.log('Unlimited Canvas history and class grouping applied.');

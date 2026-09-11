import fs from 'node:fs/promises';

const path='canvas-only.mjs';
let src=await fs.readFile(path,'utf8');

function replaceOnce(find,repl,label){
  if(!src.includes(find)) throw new Error(`Missing patch target: ${label}`);
  src=src.replace(find,repl);
}

replaceOnce(
  'getAll("/api/v1/courses?enrollment_state=active&per_page=100")',
  'getAll("/api/v1/courses?enrollment_state=active&include[]=term&per_page=100")',
  'course term include'
);

replaceOnce(
  'const activeCourses=Array.isArray(courses)?courses.filter(c=>c?.id!=null):[];',
  `const nowDate=new Date();\n      const schoolStartYear=nowDate.getMonth()>=6?nowDate.getFullYear():nowDate.getFullYear()-1;\n      const schoolEndYear=schoolStartYear+1;\n      const schoolStart=Date.parse(\`${'${schoolStartYear}'}-07-01T00:00:00Z\`);\n      const schoolEnd=Date.parse(\`${'${schoolEndYear}'}-07-01T00:00:00Z\`);\n      const courseCurrent=c=>{\n        const label=clean(c?.name||c?.course_code||\"\");\n        const ym=label.match(/\\b(20\\d{2})\\s*[-–—/]\\s*(20\\d{2})\\b/);\n        if(ym)return Number(ym[1])===schoolStartYear&&Number(ym[2])===schoolEndYear;\n        const startRaw=c?.term?.start_at||c?.start_at||\"\";\n        const endRaw=c?.term?.end_at||c?.end_at||\"\";\n        const startMs=startRaw?Date.parse(startRaw):NaN;\n        const endMs=endRaw?Date.parse(endRaw):NaN;\n        if(Number.isFinite(endMs)&&endMs<schoolStart)return false;\n        if(Number.isFinite(startMs)&&startMs>=schoolEnd)return false;\n        return true;\n      };\n      const activeCourses=Array.isArray(courses)?courses.filter(c=>c?.id!=null&&courseCurrent(c)):[];\n      const allowedCourseIds=new Set(activeCourses.map(c=>String(c.id)));`,
  'active course filter'
);

replaceOnce(
  'for(const a of group.assignments){\n          if(!a?.id)continue;',
  `for(const a of group.assignments){\n          if(!a?.id)continue;\n          const rawAssignmentDates=[a.due_at,a.updated_at,a.created_at,a?.submission?.submitted_at,a?.submission?.graded_at,a?.submission?.updated_at].filter(Boolean);\n          const assignmentDates=rawAssignmentDates.map(v=>Date.parse(v)).filter(Number.isFinite);\n          if(assignmentDates.length&&!assignmentDates.some(ms=>ms>=schoolStart&&ms<schoolEnd))continue;`,
  'assignment year filter'
);

replaceOnce(
  'const courseId=String(item?.course_id??"");\n          const course=clean(courseMap[courseId]||item?.context_name||"");',
  `const courseId=String(item?.course_id??\"\");\n          if(courseId&&!allowedCourseIds.has(courseId))continue;\n          const eventMs=item?.created_at?Date.parse(item.created_at):NaN;\n          if(Number.isFinite(eventMs)&&(eventMs<schoolStart||eventMs>=schoolEnd))continue;\n          const course=clean(courseMap[courseId]||item?.context_name||\"\");`,
  'activity year filter'
);

await fs.writeFile(path,src,'utf8');
console.log('Applied current-school-year Canvas filtering.');

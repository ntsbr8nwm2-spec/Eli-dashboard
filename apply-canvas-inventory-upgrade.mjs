import fs from "node:fs/promises";

async function patchFile(path, patches) {
  let src = await fs.readFile(path, "utf8");
  for (const patch of patches) {
    if (patch.regex) {
      if (!patch.regex.test(src)) throw new Error(`Patch target not found in ${path}: ${patch.name}`);
      src = src.replace(patch.regex, patch.value);
    } else {
      if (!src.includes(patch.from)) throw new Error(`Patch target not found in ${path}: ${patch.name}`);
      src = src.replace(patch.from, patch.to);
    }
  }
  await fs.writeFile(path, src, "utf8");
}

await patchFile("canvas-only.mjs", [
  {
    name: "add assignment inventory",
    from: "      const byId={};\n      const byCourse={};",
    to: "      const byId={};\n      const byCourse={};\n      const inventory=[];"
  },
  {
    name: "capture assignment metadata",
    from: `          const info={\n            id:String(a.id),\n            name:assignmentName,\n            normalizedName,\n            gradeText:gradeParts.join(\" · \")\n          };\n          byId[\`\${group.courseId}:\${a.id}\`]=info;\n          byCourse[group.courseId].push(info);`,
    to: `          const info={\n            id:String(a.id),\n            name:assignmentName,\n            normalizedName,\n            gradeText:gradeParts.join(\" · \"),\n            course:clean(courseMap[group.courseId]||\"\"),\n            dueAt:a.due_at||\"\",\n            submittedAt:sub.submitted_at||\"\",\n            updatedAt:a.updated_at||\"\",\n            createdAt:a.created_at||\"\",\n            workflowState:clean(sub.workflow_state||\"\"),\n            gradingType:clean(a.grading_type||\"\"),\n            published:a.published!==false,\n            excused:Boolean(sub.excused)\n          };\n          byId[\`\${group.courseId}:\${a.id}\`]=info;\n          byCourse[group.courseId].push(info);\n          inventory.push(info);`
  },
  {
    name: "track activity timestamps",
    from: "      const activity=[];\n      if(Array.isArray(stream)){",
    to: "      const activity=[];\n      const activityTimes={};\n      let recentCount=0;\n      if(Array.isArray(stream)){"
  },
  {
    name: "remove due-date stream events from not-graded inventory",
    from: "          const event=eventLabel(item);\n          let when=\"\";",
    to: "          const event=eventLabel(item);\n          if(event===\"Due date activity\")continue;\n          let when=\"\";"
  },
  {
    name: "timestamp recent activity",
    from: "          if(line&&!activity.includes(line))activity.push(line);\n          if(activity.length>=15)break;",
    to: "          if(line&&!activity.includes(line)){\n            activity.push(line);\n            activityTimes[line]=item?.created_at?(Date.parse(item.created_at)||0):0;\n            recentCount++;\n          }\n          if(recentCount>=15)break;"
  },
  {
    name: "build not graded yet from assignment inventory",
    from: "        }\n      }\n      return {firstName,activity};",
    to: `        }\n      }\n\n      const now=Date.now();\n      for(const info of inventory){\n        const gradingType=String(info.gradingType||\"\").toLowerCase();\n        const workflowState=String(info.workflowState||\"\").toLowerCase();\n        if(!info.published||info.excused||info.gradeText||gradingType===\"not_graded\"||workflowState===\"graded\")continue;\n        const dueMs=info.dueAt?Date.parse(info.dueAt):NaN;\n        if(Number.isFinite(dueMs)&&dueMs>now)continue;\n        const rawDate=info.dueAt||info.submittedAt||info.updatedAt||info.createdAt||\"\";\n        const sortMs=rawDate?(Date.parse(rawDate)||0):0;\n        let when=\"\";\n        if(rawDate){\n          const d=new Date(rawDate);\n          if(!Number.isNaN(d.getTime()))when=d.toLocaleString(\"en-US\",{month:\"short\",day:\"numeric\",hour:\"numeric\",minute:\"2-digit\"});\n        }\n        const core=[info.course,info.name].filter(Boolean).join(\" — \");\n        const line=[core,\"Not graded yet\",when].filter(Boolean).join(\" · \");\n        if(line&&!activity.includes(line)){\n          activity.push(line);\n          activityTimes[line]=sortMs;\n        }\n      }\n      activity.sort((a,b)=>(activityTimes[b]||0)-(activityTimes[a]||0));\n      return {firstName,activity};`
  }
]);

await patchFile("parent/index.html", [
  {
    name: "recognize inventory not-graded label",
    from: "const types=[['Submission','Submissions'],['Due date activity','Not Graded Yet'],",
    to: "const types=[['Submission','Submissions'],['Not graded yet','Not Graded Yet'],['Due date activity','Not Graded Yet'],"
  },
  {
    name: "highlight below 70 percent",
    from: "if(pct&&Number(pct[1])<60)return true;",
    to: "if(pct&&Number(pct[1])<70)return true;"
  },
  {
    name: "add activity date parser",
    from: "function renderActivity(activity){",
    to: `function activityTime(line){const s=String(line||'');const m=s.match(/ · ([A-Z][a-z]{2} \\d{1,2}, \\d{1,2}:\\d{2} [AP]M)$/);if(!m)return 0;const now=new Date();let t=Date.parse(\`${'${m[1]}'} ${'${now.getFullYear()}'}\`);if(!Number.isFinite(t))return 0;if(t>now.getTime()+31*86400000){const d=new Date(t);d.setFullYear(d.getFullYear()-1);t=d.getTime()}return t}\nfunction renderActivity(activity){`
  },
  {
    name: "sort each activity group newest first",
    from: "for(const item of activity){const group=activityCategory(item);(groups[group]??=[]).push(item)}return order.filter",
    to: "for(const item of activity){const group=activityCategory(item);(groups[group]??=[]).push(item)}for(const group of Object.keys(groups))groups[group].sort((a,b)=>activityTime(b)-activityTime(a));return order.filter"
  }
]);

console.log("Canvas inventory + activity sorting upgrade applied.");

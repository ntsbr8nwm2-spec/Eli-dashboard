import fs from 'node:fs/promises';

const path = 'parent/index.html';
let src = await fs.readFile(path, 'utf8');
const oldText = "function activityCategory(line){const s=String(line||'');const types=[['Submission','Submissions'],['Not graded yet','Not Graded Yet'],['Due date activity','Not Graded Yet'],['Grading','Grading'],['Quiz activity','Quiz activity'],['Assignment activity','Assignment activity'],['Discussion','Discussions'],['Message','Messages'],['Announcement','Announcements'],['Canvas activity','Other Canvas activity']];for(const [label,group] of types){if(s.includes(` · ${label} · `)||s.endsWith(` · ${label}`))return group}if(s.includes('Current grade:'))return'Submissions';return'Other activity'}";
const newText = "function activityCategory(line){const s=String(line||'');if(s.includes('Current grade:'))return'Submissions';const types=[['Submission','Submissions'],['Not graded yet','Not Graded Yet'],['Due date activity','Not Graded Yet'],['Grading','Grading'],['Quiz activity','Quiz activity'],['Assignment activity','Assignment activity'],['Discussion','Discussions'],['Message','Messages'],['Announcement','Announcements'],['Canvas activity','Other Canvas activity']];for(const [label,group] of types){if(s.includes(` · ${label} · `)||s.endsWith(` · ${label}`))return group}return'Other activity'}";
if (!src.includes(oldText)) throw new Error('Activity category target not found');
src = src.replace(oldText, newText);
await fs.writeFile(path, src, 'utf8');
console.log('Graded activity now always classifies as Submission.');

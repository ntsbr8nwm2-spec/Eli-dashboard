import fs from "node:fs/promises";

const path = "parent/index.html";
let src = await fs.readFile(path, "utf8");

const timeFn = /function activityTime\(line\)\{[^\n]*\}\n/;
if (!timeFn.test(src)) throw new Error("activityTime helper not found");
src = src.replace(timeFn, "");

const oldGrouping = "for(const item of activity){const group=activityCategory(item);(groups[group]??=[]).push(item)}for(const group of Object.keys(groups))groups[group].sort((a,b)=>activityTime(b)-activityTime(a));return order.filter";
const newGrouping = "for(const item of activity){const group=activityCategory(item);(groups[group]??=[]).push(item)}return order.filter";
if (!src.includes(oldGrouping)) throw new Error("activity group re-sort target not found");
src = src.replace(oldGrouping, newGrouping);

await fs.writeFile(path, src, "utf8");
console.log("Dashboard now preserves the collector's true timestamp order inside groups.");

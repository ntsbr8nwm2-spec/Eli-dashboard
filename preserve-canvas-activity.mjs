import fs from "node:fs/promises";

// Canvas activity preservation supports enriched assignment/submission states.
// Manual collector trigger: David enriched status refresh 1.
const DATA_PATH = "data.json";

const data = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
const activity = Array.isArray(data.activity) ? data.activity : [];
const status = String(data.activityStatus || "");

const hasCanvasLabels = activity.some(line =>
  / · (?:Submission|Missing|Submitted Late — Awaiting Grade|Submitted — Awaiting Grade|Not Submitted|Late|Canvas status:[^·]*|Due date activity|Not graded yet|Grading|Quiz activity|Assignment activity|Discussion|Message|Announcement|Canvas activity)(?: · |$)/.test(String(line || ""))
);

if (activity.length && (status.includes("Canvas activity") || hasCanvasLabels)) {
  data.canvasActivity = activity;
  data.canvasActivityStatus = status || "Canvas activity";
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`[CANVAS] Preserved ${activity.length} categorized Canvas activity item(s).`);
} else {
  console.log("[CANVAS] No categorized Canvas activity to preserve on this run.");
}

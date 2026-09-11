import fs from "node:fs/promises";

const DATA_PATH = "data.json";

const data = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
const activity = Array.isArray(data.activity) ? data.activity : [];
const status = String(data.activityStatus || "");

const hasCanvasLabels = activity.some(line =>
  / · (?:Submission|Due date activity|Grading|Quiz activity|Assignment activity|Discussion|Message|Announcement|Canvas activity)(?: · |$)/.test(String(line || ""))
);

if (activity.length && (status.includes("Recent Canvas activity") || hasCanvasLabels)) {
  data.canvasActivity = activity;
  data.canvasActivityStatus = status || "Recent Canvas activity";
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`[CANVAS] Preserved ${activity.length} categorized Canvas activity item(s).`);
} else {
  console.log("[CANVAS] No categorized Canvas activity to preserve on this run.");
}

import fs from "node:fs/promises";

const DATA_PATH = "data.json";
const SNAPSHOT_PATH = ".canvas-before.json";
const STATE_PATH = "canvas-state.json";

async function readJSON(path, fallback) {
  try { return JSON.parse(await fs.readFile(path, "utf8")); }
  catch { return fallback; }
}

async function writeJSON(path, value) {
  await fs.writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

const mode = process.argv[2];

if (mode === "before") {
  const data = await readJSON(DATA_PATH, { assignments: [] });
  await writeJSON(SNAPSHOT_PATH, {
    assignments: Array.isArray(data.assignments) ? data.assignments : []
  });
  console.log(`[CANVAS-GUARD] Saved ${Array.isArray(data.assignments) ? data.assignments.length : 0} previous assignments.`);
  process.exit(0);
}

if (mode !== "after") {
  throw new Error("Usage: node canvas-guard.mjs before|after");
}

const data = await readJSON(DATA_PATH, null);
if (!data) throw new Error("data.json could not be read by Canvas guard.");

const snapshot = await readJSON(SNAPSHOT_PATH, { assignments: [] });
const state = await readJSON(STATE_PATH, { emptyConfirmations: 0 });
const previous = Array.isArray(snapshot.assignments) ? snapshot.assignments : [];
const current = Array.isArray(data.assignments) ? data.assignments : [];

if (current.length > 0) {
  state.emptyConfirmations = 0;
  state.updatedAt = new Date().toISOString();
  await writeJSON(STATE_PATH, state);
  await fs.rm(SNAPSHOT_PATH, { force: true }).catch(() => {});
  console.log(`[CANVAS-GUARD] Canvas returned ${current.length} assignments. Empty counter reset.`);
  process.exit(0);
}

if (previous.length > 0) {
  const confirmations = Number(state.emptyConfirmations || 0) + 1;
  state.emptyConfirmations = confirmations;
  state.updatedAt = new Date().toISOString();

  if (confirmations < 2) {
    data.assignments = previous;
    await writeJSON(DATA_PATH, data);
    await writeJSON(STATE_PATH, state);
    await fs.rm(SNAPSHOT_PATH, { force: true }).catch(() => {});
    console.log(`[CANVAS-GUARD] Canvas returned zero once. Preserved ${previous.length} previous assignments; waiting for a second consecutive zero.`);
    process.exit(0);
  }

  await writeJSON(STATE_PATH, state);
  await fs.rm(SNAPSHOT_PATH, { force: true }).catch(() => {});
  console.log("[CANVAS-GUARD] Canvas returned zero twice consecutively. Empty list confirmed and allowed.");
  process.exit(0);
}

state.emptyConfirmations = 0;
state.updatedAt = new Date().toISOString();
await writeJSON(STATE_PATH, state);
await fs.rm(SNAPSHOT_PATH, { force: true }).catch(() => {});
console.log("[CANVAS-GUARD] Canvas returned zero and there were no previous assignments to preserve.");

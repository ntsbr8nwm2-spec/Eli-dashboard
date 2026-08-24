import fs from "node:fs/promises";

const DATA_PATH = "data.json";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanCanvasTitle(value) {
  let title = cleanText(value);

  // Canvas sometimes appends the whole calendar/sidebar accessibility text
  // to an assignment title. Cut only at strong navigation signatures.
  const markers = [
    /\s+CALENDARS\b/i,
    /\s+UNDATED\b/i,
    /\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}(?=\s+(?:\d{1,2}\s+){7,})/i
  ];

  for (const marker of markers) {
    const match = title.match(marker);
    if (match?.index > 0) title = title.slice(0, match.index).trim();
  }

  title = title
    .replace(/^Assignment\s*,?\s*/i, "")
    .replace(/^Quiz\s*,?\s*/i, "")
    .replace(/^Discussion\s*,?\s*/i, "")
    .trim();

  return title;
}

function cleanCanvasCourse(value) {
  const course = cleanText(value);
  if (!course) return "Canvas";
  if (/^(feed|calendar|agenda|undated|canvas)$/i.test(course)) return "Canvas";
  if (/\b(?:Open|Color Picker|CALENDARS)\b/i.test(course)) return "Canvas";
  return course;
}

const data = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
const original = Array.isArray(data.assignments) ? data.assignments : [];

const cleaned = original
  .map(item => ({
    ...item,
    day: cleanText(item.day),
    time: cleanText(item.time),
    course: cleanCanvasCourse(item.course),
    title: cleanCanvasTitle(item.title)
  }))
  .filter(item => item.title && item.title.length <= 220);

if (JSON.stringify(cleaned) !== JSON.stringify(original)) {
  data.assignments = cleaned;
  data.updatedAt = new Date().toISOString();
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`[SANITIZE] Cleaned ${original.length} Canvas assignment(s).`);
} else {
  console.log("[SANITIZE] No Canvas cleanup needed.");
}

// Shared validation / sanitization for model output.
// This is the guard that runs BEFORE anything is written to a calendar:
// it strips control characters, enforces a strict schema, drops instruction-like
// text (prompt-injection attempts hidden in an uploaded image), and caps volume.

const TYPES = ["assignment", "exam", "quiz", "reading", "project", "class", "event", "holiday", "payment", "other"];

// Patterns that look like an instruction to the model rather than a real event title.
const INJECTION = /(ignore\s+(all|previous|above|prior)|disregard\s+(the|all|previous)|system\s*prompt|you\s+are\s+now|assistant\s*:|<\s*\/?\s*script|javascript:|data:text\/html|prompt\s*inject|override\s+(the|your)|new\s+instructions)/i;

function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function cleanRemind(v) {
  const n = parseInt(v, 10);
  if (Number.isFinite(n) && n >= 0 && n <= 40320) return String(n); // up to 4 weeks
  return "";
}

// Validate + sanitize a list of model-produced items. Returns only safe events.
function sanitizeEvents(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const o of items.slice(0, 300)) {
    if (!o || typeof o !== "object") continue;
    const date = String(o.d || o.date || "");
    if (!isRealDate(date)) continue; // no date, no event

    let title = String(o.t || o.title || "")
      .replace(/[\u0000-\u001F\u007F]/g, " ") // strip control chars
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (!title) title = "Untitled";
    if (INJECTION.test(title)) continue; // drop instruction-like titles entirely

    let time = String(o.h || o.time || "");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) time = "";

    const rawType = o.y || o.type;
    const type = TYPES.includes(rawType) ? rawType : "other";

    out.push({ title, date, time, type, remind: cleanRemind(o.remind) });
    if (out.length >= 200) break; // hard cap on volume
  }
  return out;
}

module.exports = { TYPES, sanitizeEvents, isRealDate };

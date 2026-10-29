// SnapCal backend — secure scan endpoint.
// The app sends a photo here; this calls Claude with your secret key and
// returns the calendar name + dated events. The key never leaves the server.
//
// Env vars (set in Vercel project settings):
//   ANTHROPIC_API_KEY   (required) your sk-ant-... key
//   ALLOWED_ORIGIN      (recommended) e.g. https://snapcal.vercel.app  — locks CORS
//   APP_SHARED_KEY      (optional) a long random string; the app must send it too
//
// Abuse protection built in: requires a device id, rate-limits per device/IP,
// and rejects oversized payloads. For durable limits across all servers, add
// Upstash Redis later (see REVIEW-CHECKLIST.md).

const { sanitizeEvents, sanitizeText } = require("./_lib.js");

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_WINDOW = 25;        // scans per device/IP per hour
const hits = new Map();
function rateLimited(key) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) { for (const k of hits.keys()) { if ((hits.get(k) || []).every((t) => now - t > WINDOW_MS)) hits.delete(k); } }
  return false;
}

module.exports = async (req, res) => {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-snapcal-device, x-snapcal-key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY" });

  // Optional shared app key
  if (process.env.APP_SHARED_KEY && req.headers["x-snapcal-key"] !== process.env.APP_SHARED_KEY) {
    return res.status(401).json({ error: "Not authorized" });
  }

  // Device verification: the app must identify itself with a device id
  const device = (req.headers["x-snapcal-device"] || "").toString().slice(0, 100);
  if (!device) return res.status(400).json({ error: "Missing device id" });

  // Rate limit by device, with IP as a backstop
  const ip = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || "noip";
  if (rateLimited("d:" + device) || rateLimited("i:" + ip)) {
    return res.status(429).json({ error: "Too many scans. Try again later." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { image, mediaType, isPdf } = body;
    // Pasted or uploaded text takes the text path; the image path is unchanged.
    const pasted = typeof body.text === "string" ? body.text.trim() : "";
    const isText = pasted.length > 0;
    if (isText) {
      if (pasted.length > 20000) return res.status(413).json({ error: "That text is too long. Trim it under 20,000 characters." });
    } else {
      if (!image) return res.status(400).json({ error: "No image data sent" });
      if (image.length > 7_000_000) return res.status(413).json({ error: "Image too large" });
    }

    const today = new Date().toISOString().slice(0, 10);
    const intro = isText
      ? "Read the schedule text below (a schedule, calendar, syllabus, or similar). Do not transcribe it back. Do two jobs:"
      : "Look at this document (a schedule, calendar, syllabus, or similar). Do not transcribe the body text. Do two jobs:";
    const prompt = `${intro}
1) Read the big title or header and turn it into a short calendar name (e.g. "Millbrook Athletics May 2024").
2) Read the month and year, then list EVERY dated item on the page.

Today is ${today}.

Return ONLY one compact JSON object. No prose, no explanation, no code fences:
{"cal":"short calendar name from the title","items":[{"t":"short title","d":"YYYY-MM-DD","h":"HH:MM 24h or null","y":"type"}]}

"y" must be one of: assignment, exam, quiz, reading, project, presentation, class, event, holiday, payment, other.
Use "presentation" for presentations, case presentations, pitches, demos, oral reports, defenses. Use "event" for games, matches, activities, meetings, pep rallies, banquets. Use "exam" for tests, midterms, finals.

Rules:
- Use the month and year shown in the document. If a year is missing, pick the next occurrence on or after today.
- "h" is null unless a clock time is shown. TBD or no time means null. Never invent times.
- Skip empty "No Events" cells. Deduplicate. Be thorough: capture every dated entry, even on a packed calendar.`;

    const content = isText
      ? [{ type: "text", text: prompt + "\n\nSchedule text:\n" + pasted }]
      : [
          isPdf
            ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: image } }
            : { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: image } },
          { type: "text", text: prompt },
        ];

    const apiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", // confirm current id at docs.claude.com/en/docs/about-claude/models
        max_tokens: 4096,
        messages: [{ role: "user", content }],
      }),
    });

    const data = await apiResp.json();
    if (data.error) {
      console.error("model error:", data.error.message);
      return res.status(502).json({ error: "Model error" }); // do not echo model text to the client
    }

    const outText = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    let items = [], cal = "";
    const oa = outText.indexOf("{"), oz = outText.lastIndexOf("}");
    let obj = null;
    if (oa !== -1 && oz > oa) { try { obj = JSON.parse(outText.slice(oa, oz + 1)); } catch (_) {} }
    if (obj && Array.isArray(obj.items)) { items = obj.items; cal = obj.cal || ""; }
    else {
      const a = outText.indexOf("["), z = outText.lastIndexOf("]");
      const slice = a !== -1 ? outText.slice(a, z > a ? z + 1 : outText.length) : outText;
      try { items = JSON.parse(slice); }
      catch (_) { items = (slice.match(/\{[^{}]*\}/g) || []).map((m) => { try { return JSON.parse(m); } catch (e) { return null; } }).filter(Boolean); }
      const cm = outText.match(/"cal"\s*:\s*"([^"]+)"/); if (cm) cal = cm[1];
    }

    const events = sanitizeEvents(items); // validate + strip injection before returning

    return res.status(200).json({ cal: sanitizeText(cal), items: events });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
};

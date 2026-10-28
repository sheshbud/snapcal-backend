// SnapCal Google Calendar endpoint — OAuth 2.0 authorization-code flow.
// The browser sends only a short-lived auth code. This function exchanges it
// for an access token using the client secret (SERVER-SIDE ONLY), then writes
// the events to the user's Google Calendar. The token is never returned to or
// stored on the client. Events are re-validated here before any write.
//
// Env vars (backend Vercel project):
//   GOOGLE_CLIENT_ID      (public id, also used by the web app)
//   GOOGLE_CLIENT_SECRET  (secret, never sent to the client)

const { sanitizeEvents } = require("./_lib.js");

function pad(n) { return String(n).padStart(2, "0"); }
function nextDay(d) { const dt = new Date(d + "T00:00:00Z"); dt.setUTCDate(dt.getUTCDate() + 1); return dt.toISOString().slice(0, 10); }
function addHour(t) { let [h, m] = t.split(":").map(Number); h = (h + 1) % 24; return pad(h) + ":" + pad(m); }

function toGoogleEvent(e, tz) {
  const ev = { summary: e.title };
  if (!e.time) { ev.start = { date: e.date }; ev.end = { date: nextDay(e.date) }; }
  else {
    ev.start = { dateTime: `${e.date}T${e.time}:00`, timeZone: tz };
    ev.end = { dateTime: `${e.date}T${addHour(e.time)}:00`, timeZone: tz };
  }
  // remind may hold several values as "10,60,1440"
  const mins = String(e.remind || "").split(",").map((v) => parseInt(v, 10)).filter((v) => Number.isFinite(v) && v >= 0).slice(0, 5);
  if (mins.length) ev.reminders = { useDefault: false, overrides: mins.map((m) => ({ method: "popup", minutes: m })) };
  return ev;
}

module.exports = async (req, res) => {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-snapcal-device");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).json({ error: "Google not configured on server" });
  }
  if (!(req.headers["x-snapcal-device"] || "").toString().trim()) {
    return res.status(400).json({ error: "Missing device id" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { code, redirectUri, events, tz } = body;
    if (!code || !redirectUri) return res.status(400).json({ error: "Missing code or redirect" });

    // 1) Exchange the auth code for an access token — secret stays here.
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const token = await tokenResp.json();
    if (!token.access_token) return res.status(401).json({ error: "Google sign-in failed" });

    // 2) Re-validate the events before writing anything to the calendar.
    const safe = sanitizeEvents(events);
    if (!safe.length) return res.status(400).json({ error: "No valid events to add" });
    const zone = typeof tz === "string" && tz.length < 60 ? tz : "UTC";

    // 3) Write each event to the user's primary calendar.
    let added = 0;
    for (const e of safe) {
      const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token.access_token },
        body: JSON.stringify(toGoogleEvent(e, zone)),
      });
      if (r.ok) added++;
    }

    // Token is intentionally discarded here; nothing is returned to the client.
    return res.status(200).json({ added });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
};

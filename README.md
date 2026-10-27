# SnapCal backend — make the scan live

This is the "drive-thru window" that lets the photo scan actually work for real users. The app sends a photo here, this server calls the AI with your secret key, and sends back the dates. The app never touches the key.

Anthropic's own guidance: never put an API key in client-side code or a mobile app, always route through a secure backend. That is exactly what this does.

---

## What's in here

- `api/scan.js` — the function that does the scan.
- `package.json` — no dependencies, uses built-in fetch (Node 18+).

---

## Deploy it (about 15 minutes, free)

1. **Get an Anthropic API key.** Go to console.anthropic.com, make an account, add a little credit, and create an API key under Settings. Copy it. It starts with `sk-ant-`.

2. **Put these files in a folder** on your computer (keep the `api/` subfolder structure).

3. **Deploy to Vercel.**
   - Easiest: push the folder to a GitHub repo, go to vercel.com, "Add New Project," import the repo.
   - Or install the CLI: `npm i -g vercel`, then run `vercel` inside the folder and follow the prompts.

4. **Add your key as an environment variable.** In the Vercel project: Settings, Environment Variables, add `ANTHROPIC_API_KEY` = your `sk-ant-...` key. Redeploy so it takes effect.

5. **You now have a live URL** like `https://snapcal-backend.vercel.app`. Your scan endpoint is that URL plus `/api/scan`.

6. **Test it** from a terminal (swap in your URL):
   ```
   curl -X POST https://snapcal-backend.vercel.app/api/scan \
     -H "Content-Type: application/json" \
     -d '{"image":"<base64-of-a-photo>","mediaType":"image/jpeg"}'
   ```
   You should get back `{"cal":"...","items":[...]}`.

---

## Point the app at it

In the SnapCal app code, the scan currently calls the AI directly (which is what gets blocked). Replace that part of the `onFile` function with a call to your backend instead. The shrink-the-image step stays the same; you just change where the request goes.

```js
// after you have `data64` (the shrunk base64 image) and `isPdf`:
const SCAN_URL = "https://snapcal-backend.vercel.app/api/scan"; // your URL

let data = null, lastErr = null;
for (let attempt = 0; attempt < 2 && !data; attempt++) {
  try {
    const resp = await fetch(SCAN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: data64, mediaType: "image/jpeg", isPdf }),
    });
    const d = await resp.json();
    if (d.error) throw new Error(d.error);
    data = d; // { cal, items }
  } catch (err) { lastErr = err; }
}
if (!data) throw (lastErr || new Error("Scan failed"));

// then build your drafts from data.items (each item is {title, date, time, type})
const cleaned = data.items.map((o) => ({
  title: o.title, date: o.date, time: o.time, type: o.type,
  color: DEFAULT_TYPE_COLORS[o.type] || "#2F62F0",
  notes: "", remind: bulkRemind, on: true,
}));
setDraft(cleaned);
setSuggestName((data.cal || "").trim());
setTargetCal((data.cal || "").trim() ? "__new__" : calendars[0].id);
setStage("review");
```

The backend already returns the same shape the app expects, so the rest of the flow (confirm screen, colors, reminders, .ics export) works unchanged.

---

## Cost and safety

- Each scan is one Sonnet 4.6 call with one image, on the order of a cent or two. Check current pricing at docs.claude.com.
- To stop strangers from using your endpoint (and your credit), later you can lock the `Access-Control-Allow-Origin` to your app's domain and add a simple shared secret or rate limit.
- Confirm the current model id and pricing at https://docs.claude.com/en/docs/about-claude/models before launch; model names update over time.

---

## Why this is the real fix

The artifact preview can't make this call, which is why scanning failed there. A normal web server can, and a phone app talking to this server can too. This is the piece that turns the prototype into a shippable product. Everything else, the design, calendar, colors, reminders, export, manual entry, is already built.

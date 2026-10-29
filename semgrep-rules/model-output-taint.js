// Test cases for unsanitized-model-output. Run: semgrep --test --config .semgrep
function bad(res, outText) {
  const obj = JSON.parse(outText);
  const cal = obj.cal || "";
  // ruleid: unsanitized-model-output
  return res.status(200).json({ cal });
}

function badRegex(res, outText) {
  const cm = outText.match(/"cal"\s*:\s*"([^"]+)"/);
  const cal = cm ? cm[1] : "";
  // ruleid: unsanitized-model-output
  return res.status(200).json({ cal });
}

function good(res, outText) {
  const items = JSON.parse(outText);
  const events = sanitizeEvents(items);
  // ok: unsanitized-model-output
  return res.status(200).json({ items: events });
}

function goodCalendarWrite(cal, outText) {
  const safe = sanitizeEvents(JSON.parse(outText));
  // ok: unsanitized-model-output
  return cal.events.insert({ resource: safe });
}

function goodScalar(res, outText) {
  const cm = outText.match(/"cal"\s*:\s*"([^"]+)"/);
  const cal = cm ? cm[1] : "";
  // ok: unsanitized-model-output
  return res.status(200).json({ cal: sanitizeText(cal) });
}

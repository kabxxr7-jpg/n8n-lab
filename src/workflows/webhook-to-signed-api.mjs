// Workflow 2: webhook -> validate -> 202 -> HMAC-signed call -> confidence branch
// (high: straight on, low: review queue) -> callback to the caller's URL.
import { Flow, codeFile, at } from "../lib/wfkit.mjs";
import { URLS } from "../lib/endpoints.mjs";

export function buildSignedApi() {
  const f = new Flow("Webhook to signed API with confidence branch", {
    settings: { timezone: "UTC", saveDataErrorExecution: "all", saveDataSuccessExecution: "all" },
  });
  const ev = "$('Validate event').first().json.event";

  f.webhook("Webhook: event", { path: "signed-intake", pos: at(0, 0) });
  f.code("Validate event", codeFile("validate-signed-event.js"), at(1, 0));
  f.ifTrue("Event valid?", "$json.valid === true", at(2, 0));
  f.respond("Respond 400 invalid event", {
    code: 400,
    body: "{ error: 'invalid_event', details: $json.errors }",
    pos: at(2, 1),
  });
  f.respond("Respond 202 accepted", {
    code: 202,
    body: "{ accepted: true, event_id: $json.event.event_id }",
    pos: at(3, 0),
  });
  f.code("Sign request", codeFile("sign-request.js"), at(4, 0), {
    note: "HMAC-SHA256 over '<unix seconds>.<body>' using LAB_SIGNING_SECRET from the environment.",
  });
  f.http("Call signed API", {
    method: "POST",
    url: `${URLS.signed}/v1/classify`,
    headers: { "X-Lab-Timestamp": "={{ $json.timestamp }}", "X-Lab-Signature": "={{ $json.signature }}" },
    raw: "={{ $json.bodyString }}",
    rawType: "application/json",
    timeout: 5000,
    pos: at(5, 0),
    node: { onError: "continueErrorOutput" },
  });
  f.ifTrue("Confident?", "Number($json.confidence) >= 0.8", at(6, 0));
  f.http("Callback: auto processed", {
    method: "POST",
    url: `={{ ${ev}.callback_url }}`,
    json: "{ event_id: $json.event_id, status: 'auto_processed', label: $json.label, confidence: $json.confidence }",
    timeout: 5000,
    pos: at(7, 0),
  });
  f.http("Add to review queue", {
    method: "POST",
    url: `${URLS.tables}/tables/review_queue/rows`,
    json: `{ event_id: ${ev}.event_id, label: $json.label, confidence: $json.confidence, text: ${ev}.text, reason: 'low_confidence', status: 'open' }`,
    timeout: 5000,
    pos: at(7, 1),
  });
  f.http("Callback: needs review", {
    method: "POST",
    url: `={{ ${ev}.callback_url }}`,
    json: `{ event_id: ${ev}.event_id, status: 'needs_review', review_id: $json.id, label: $json.label, confidence: $json.confidence }`,
    timeout: 5000,
    pos: at(8, 1),
  });
  f.http("Callback: failed", {
    method: "POST",
    url: `={{ ${ev}.callback_url }}`,
    json: `{ event_id: ${ev}.event_id, status: 'failed', reason: 'classifier_error' }`,
    timeout: 5000,
    pos: at(6, 2),
  });

  f.connect("Webhook: event", "Validate event")
    .connect("Validate event", "Event valid?")
    .connect("Event valid?", "Respond 202 accepted", 0)
    .connect("Event valid?", "Respond 400 invalid event", 1)
    .connect("Respond 202 accepted", "Sign request")
    .connect("Sign request", "Call signed API")
    .connect("Call signed API", "Confident?", 0)
    .connect("Call signed API", "Callback: failed", 1)
    .connect("Confident?", "Callback: auto processed", 0)
    .connect("Confident?", "Add to review queue", 1)
    .connect("Add to review queue", "Callback: needs review");
  return f;
}

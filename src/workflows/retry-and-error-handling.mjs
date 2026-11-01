// Workflow 3: dedupe by event id (atomic claim), retry-on-fail with a fixed wait,
// permanent failure -> release the claim, answer 502, fail the execution so the
// Error Workflow records it. Plus the Error Workflow itself.
import { Flow, codeFile, at } from "../lib/wfkit.mjs";
import { URLS, ERROR_WORKFLOW_ID } from "../lib/endpoints.mjs";

export const RETRY = { maxTries: 3, waitBetweenTries: 1000, timeoutMs: 1500 };

export function buildRetryFlow() {
  const f = new Flow("Retry, dedupe and error handling", {
    settings: {
      timezone: "UTC",
      saveDataErrorExecution: "all",
      saveDataSuccessExecution: "all",
      errorWorkflow: ERROR_WORKFLOW_ID,
    },
  });
  const claims = `${URLS.tables}/tables/event_claims/rows`;
  const claimUrl = `={{ '${claims}/' + $('Validate event').first().json.event_id }}`;

  f.webhook("Webhook: event", { path: "events", pos: at(0, 0) });
  f.code("Validate event", codeFile("validate-event.js"), at(1, 0));
  f.ifTrue("Event valid?", "$json.valid === true", at(2, 0));
  f.respond("Respond 400 invalid event", {
    code: 400,
    body: "{ error: 'invalid_event', details: $json.errors }",
    pos: at(2, 1),
  });
  f.http("Claim event id", {
    method: "POST",
    url: claims,
    json: "{ id: $json.event_id, type: $json.type, status: 'processing' }",
    full: true,
    timeout: 5000,
    pos: at(3, 0),
    node: { notes: "Atomic insert on a unique key. 201 = first delivery. 409 = seen before: done -> 200 duplicate, still processing -> 409 in_progress." },
  });
  f.ifTrue("First delivery?", "$json.statusCode === 201", at(4, 0));
  f.respond("Respond duplicate", {
    code: "={{ $json.statusCode !== 409 ? 503 : $json.body.existing_status === 'done' ? 200 : 409 }}",
    body:
      "$json.statusCode !== 409 ? { error: 'claim_store_unavailable' } : " +
      "{ status: $json.body.existing_status === 'done' ? 'duplicate' : 'in_progress', event_id: $('Validate event').first().json.event_id }",
    pos: at(4, 1),
  });
  f.http("Call flaky API", {
    method: "POST",
    url: `${URLS.flaky}/v1/process`,
    json: "{ event_id: $('Validate event').first().json.event_id, type: $('Validate event').first().json.type, data: $('Validate event').first().json.data }",
    timeout: RETRY.timeoutMs,
    pos: at(5, 0),
    node: {
      retryOnFail: true,
      maxTries: RETRY.maxTries,
      waitBetweenTries: RETRY.waitBetweenTries,
      onError: "continueErrorOutput",
    },
  });
  f.http("Mark claim done", {
    method: "PATCH",
    url: claimUrl,
    json: "{ status: 'done' }",
    timeout: 5000,
    pos: at(6, 0),
  });
  f.respond("Respond 200 processed", {
    code: 200,
    body: "{ status: 'processed', event_id: $json.id }",
    pos: at(7, 0),
  });
  f.http("Release claim", {
    method: "DELETE",
    url: claimUrl,
    timeout: 5000,
    pos: at(6, 1),
    node: { notes: "Without this a failed event would be treated as a duplicate when the sender redelivers it." },
  });
  f.respond("Respond 502 failed", {
    code: 502,
    body: "{ status: 'failed', event_id: $('Validate event').first().json.event_id }",
    pos: at(7, 1),
  });
  f.add(
    "Fail execution",
    "n8n-nodes-base.stopAndError",
    1,
    {
      errorMessage:
        "=Event {{ $('Validate event').first().json.event_id }} failed after retries: {{ $('Call flaky API').first().json.error ? $('Call flaky API').first().json.error.message : 'upstream error' }}",
    },
    at(8, 1),
  );

  f.connect("Webhook: event", "Validate event")
    .connect("Validate event", "Event valid?")
    .connect("Event valid?", "Claim event id", 0)
    .connect("Event valid?", "Respond 400 invalid event", 1)
    .connect("Claim event id", "First delivery?")
    .connect("First delivery?", "Call flaky API", 0)
    .connect("First delivery?", "Respond duplicate", 1)
    .connect("Call flaky API", "Mark claim done", 0)
    .connect("Call flaky API", "Release claim", 1)
    .connect("Mark claim done", "Respond 200 processed")
    .connect("Release claim", "Respond 502 failed")
    .connect("Respond 502 failed", "Fail execution");
  return f;
}

export function buildErrorWorkflow() {
  const f = new Flow("Error handler: record failure to alerts", {
    id: ERROR_WORKFLOW_ID,
    settings: { timezone: "UTC", saveDataErrorExecution: "all", saveDataSuccessExecution: "all" },
  });
  f.add("Error Trigger", "n8n-nodes-base.errorTrigger", 1, {}, at(0, 0));
  f.code("Format alert", codeFile("format-alert.js"), at(1, 0));
  f.http("Post alert", {
    method: "POST",
    url: `${URLS.alerts}/alerts`,
    json: "$json",
    timeout: 5000,
    pos: at(2, 0),
    node: { retryOnFail: true, maxTries: 3, waitBetweenTries: 500 },
  });
  f.connect("Error Trigger", "Format alert").connect("Format alert", "Post alert");
  return f;
}

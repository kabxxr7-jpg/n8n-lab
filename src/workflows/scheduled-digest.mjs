// Workflow 4: Schedule Trigger -> read the last 24h of leads (all pages) ->
// build a digest -> mail it, unless there is nothing to report.
import { Flow, codeFile, at } from "../lib/wfkit.mjs";
import { URLS, ERROR_WORKFLOW_ID } from "../lib/endpoints.mjs";

export const DIGEST_CRON = "0 8 * * *";
export const DIGEST_TZ = "Asia/Kolkata";

export function buildDigest() {
  const f = new Flow("Scheduled lead digest", {
    settings: {
      timezone: DIGEST_TZ,
      saveDataErrorExecution: "all",
      saveDataSuccessExecution: "all",
      errorWorkflow: ERROR_WORKFLOW_ID,
    },
  });
  f.add(
    "Schedule Trigger",
    "n8n-nodes-base.scheduleTrigger",
    1.4,
    { rule: { interval: [{ field: "cronExpression", expression: DIGEST_CRON }] } },
    at(0, 0),
    { notes: "08:00 every day in the workflow time zone (Asia/Kolkata)." },
  );
  f.code("Compute window", codeFile("compute-window.js"), at(1, 0));
  f.http("Fetch leads (all pages)", {
    url: `${URLS.tables}/tables/leads/rows`,
    query: { created_after: "={{ $json.since }}", page_size: "50" },
    timeout: 8000,
    pagination: {
      paginationMode: "updateAParameterInEachRequest",
      parameters: { parameters: [{ type: "qs", name: "page", value: "={{ $pageCount + 1 }}" }] },
      paginationCompleteWhen: "other",
      completeExpression: "={{ $response.body.has_more === false }}",
      limitPagesFetched: true,
      maxRequests: 50,
    },
    pos: at(2, 0),
  });
  f.code("Build digest", codeFile("build-digest.js"), at(3, 0));
  f.ifTrue("Anything to report?", "$json.total > 0", at(4, 0));
  f.http("Send digest", {
    method: "POST",
    url: `${URLS.outbox}/outbox`,
    json: "{ to: $json.to, subject: $json.subject, body: $json.body }",
    timeout: 8000,
    pos: at(5, 0),
  });
  f.add("Empty day: send nothing", "n8n-nodes-base.noOp", 1, {}, at(5, 1));
  f.connect("Schedule Trigger", "Compute window")
    .connect("Compute window", "Fetch leads (all pages)")
    .connect("Fetch leads (all pages)", "Build digest")
    .connect("Build digest", "Anything to report?")
    .connect("Anything to report?", "Send digest", 0)
    .connect("Anything to report?", "Empty day: send nothing", 1);
  return f;
}

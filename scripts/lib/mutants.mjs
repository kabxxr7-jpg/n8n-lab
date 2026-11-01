// The mutants: small, plausible bugs applied to a COPY of a workflow's JSON.
// Every edit helper throws when it cannot find what it is meant to change, so a
// mutant can never silently turn into a no-op after the workflow is refactored.
const T = {
  lead: "test/lead-approval-gate.test.mjs",
  signed: "test/webhook-to-signed-api.test.mjs",
  retry: "test/retry-and-error-handling.test.mjs",
  digest: "test/scheduled-digest.test.mjs",
};

const node = (wf, name) => {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`mutant: no node "${name}"`);
  return n;
};
const condition = (wf, ifName) => node(wf, ifName).parameters.conditions.conditions[0];

function flipIf(wf, name) {
  const op = condition(wf, name).operator;
  if (op.operation !== "true") throw new Error(`mutant: ${name} is not a boolean-true condition`);
  op.operation = "false";
}
function setIf(wf, name, expr) {
  condition(wf, name).leftValue = `={{ ${expr} }}`;
}
function replaceOnce(text, from, to, where) {
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`mutant: text not found in ${where}: ${from.slice(0, 80)}`);
  if (text.indexOf(from, first + 1) >= 0) throw new Error(`mutant: text occurs more than once in ${where}: ${from.slice(0, 80)}`);
  return text.replace(from, () => to);
}
function code(wf, name, from, to) {
  const n = node(wf, name);
  n.parameters.jsCode = replaceOnce(n.parameters.jsCode, from, to, name);
}
function param(wf, name, key, from, to) {
  const n = node(wf, name);
  n.parameters[key] = replaceOnce(String(n.parameters[key]), from, to, `${name}.${key}`);
}
function edge(wf, from, out) {
  return wf.connections[from]?.main?.[out] ?? [];
}
function rewire(wf, from, out, oldTo, newTo) {
  const e = edge(wf, from, out).find((x) => x.node === oldTo);
  if (!e) throw new Error(`mutant: no edge ${from}[${out}] -> ${oldTo}`);
  e.node = newTo;
}
function dropEdge(wf, from, out, to) {
  const list = edge(wf, from, out);
  const i = list.findIndex((x) => x.node === to);
  if (i < 0) throw new Error(`mutant: no edge ${from}[${out}] -> ${to}`);
  list.splice(i, 1);
}
function addEdge(wf, from, out, to) {
  wf.connections[from].main[out].push({ node: to, type: "main", index: 0 });
}
function swapOutputs(wf, name) {
  const main = wf.connections[name].main;
  if (main.length !== 2) throw new Error(`mutant: ${name} does not have two outputs`);
  main.reverse();
}

const re = String.raw;

export const MUTANTS = [
  // ---------------------------------------------------------------- lead approval gate (rules)
  {
    id: "gate-flip-claim-if",
    workflow: "lead-approval-gate.json",
    tests: [T.lead],
    description: 'flip the "Claim won?" condition',
    apply: (wf) => flipIf(wf, "Claim won?"),
  },
  {
    id: "gate-remove-approval-check",
    workflow: "lead-approval-gate.json",
    tests: [T.lead],
    description: 'the "Claim won?" check always passes (second approvals go on to send)',
    apply: (wf) => setIf(wf, "Claim won?", "true"),
  },
  {
    id: "gate-send-before-approval",
    workflow: "lead-approval-gate.json",
    tests: [T.lead],
    description: "intake goes straight to Send email (no approval needed)",
    apply: (wf) => {
      addEdge(wf, "Write lead (pending)", 0, "Send email");
      param(
        wf,
        "Send email",
        "jsonBody",
        "to: $json.body.email, subject: $json.body.draft_subject, body: $json.body.draft_body, lead_id: $json.body.id",
        "to: ($json.body || $json).email, subject: ($json.body || $json).draft_subject, body: ($json.body || $json).draft_body, lead_id: ($json.body || $json).id",
      );
      const header = node(wf, "Send email").parameters.headerParameters.parameters[0];
      header.value = "={{ ($json.body || $json).id }}";
    },
  },
  {
    id: "gate-claim-without-precondition",
    workflow: "lead-approval-gate.json",
    tests: [T.lead],
    description: 'drop the if_status precondition from "Claim for sending"',
    apply: (wf) => {
      const n = node(wf, "Claim for sending");
      delete n.parameters.sendQuery;
      delete n.parameters.queryParameters;
    },
  },
  {
    id: "gate-allow-resend-after-sent",
    workflow: "lead-approval-gate.json",
    tests: [T.lead],
    description: "claim also accepts leads that are already sent",
    apply: (wf) => {
      node(wf, "Claim for sending").parameters.queryParameters.parameters[0].value = "pending,send_failed,sent";
    },
  },
  {
    id: "gate-skip-not-found-check",
    workflow: "lead-approval-gate.json",
    tests: [T.lead],
    description: 'the "Lead found?" check always passes (unknown id is not reported as 404)',
    apply: (wf) => setIf(wf, "Lead found?", "true"),
  },
  {
    id: "gate-lookup-failure-always-404",
    workflow: "lead-approval-gate.json",
    tests: [T.lead],
    description: "a storage failure on lookup is reported as 404 lead_not_found",
    apply: (wf) => {
      const o = node(wf, "Respond lookup failed").parameters.options;
      o.responseCode = replaceOnce(o.responseCode, "$json.statusCode === 404 ? 404 : 502", "404", "Respond lookup failed.responseCode");
    },
  },
  {
    id: "gate-flip-lead-valid",
    workflow: "lead-approval-gate.json",
    tests: [T.lead],
    description: 'flip the "Lead valid?" condition',
    apply: (wf) => flipIf(wf, "Lead valid?"),
  },
  {
    id: "gate-flip-approval-valid",
    workflow: "lead-approval-gate.json",
    tests: [T.lead],
    description: 'flip the "Approval valid?" condition',
    apply: (wf) => flipIf(wf, "Approval valid?"),
  },
  {
    id: "gate-store-as-approved",
    workflow: "lead-approval-gate.json",
    tests: [T.lead],
    description: "intake stores the lead with status approved instead of pending",
    apply: (wf) => param(wf, "Write lead (pending)", "jsonBody", "status: 'pending'", "status: 'approved'"),
  },
  {
    id: "gate-tier-cutoff",
    workflow: "lead-approval-gate.json",
    tests: [T.lead],
    description: "medium tier starts at 65 instead of 40",
    apply: (wf) => code(wf, "Score lead (rules)", "score >= 40 ? 'medium'", "score >= 65 ? 'medium'"),
  },
  {
    id: "gate-budget-weight",
    workflow: "lead-approval-gate.json",
    tests: [T.lead],
    description: "budget over 5000 USD is worth 10 points instead of 30",
    apply: (wf) => code(wf, "Score lead (rules)", "add(30, 'budget at least 5000 USD')", "add(10, 'budget at least 5000 USD')"),
  },
  {
    id: "gate-email-check-removed",
    workflow: "lead-approval-gate.json",
    tests: [T.lead],
    description: "email format check removed from validation",
    apply: (wf) => code(wf, "Validate lead", re`!/^[^\s@<>,;:"']+@[^\s@<>,;:"']+\.[a-z]{2,}$/i.test(email)`, "false"),
  },
  {
    id: "gate-wrong-recipient",
    workflow: "lead-approval-gate.json",
    tests: [T.lead],
    description: "email is sent to the lead's name field instead of the address",
    apply: (wf) => param(wf, "Send email", "jsonBody", "to: $json.body.email", "to: $json.body.name"),
  },
  {
    id: "gate-failed-send-marked-sent",
    workflow: "lead-approval-gate.json",
    tests: [T.lead],
    description: 'a failed send is wired to "Mark sent"',
    apply: (wf) => rewire(wf, "Send email", 1, "Mark send_failed", "Mark sent"),
  },
  // ---------------------------------------------------------------- lead approval gate (LLM)
  {
    id: "llm-no-fallback",
    workflow: "lead-approval-gate-llm.json",
    tests: [T.lead],
    description: "LLM request errors stop the workflow instead of falling back to the rules",
    apply: (wf) => {
      const n = node(wf, "Ask LLM (mock)");
      if (n.onError !== "continueRegularOutput") throw new Error("mutant: unexpected onError");
      delete n.onError;
    },
  },
  {
    id: "llm-score-range-unchecked",
    workflow: "lead-approval-gate-llm.json",
    tests: [T.lead],
    description: "the 0-100 range check on the LLM score is removed",
    apply: (wf) => code(wf, "Parse LLM answer", "parsed.fit_score >= 0 && parsed.fit_score <= 100", "true"),
  },
  // ---------------------------------------------------------------- signed API
  {
    id: "signed-wrong-secret",
    workflow: "webhook-to-signed-api.json",
    tests: [T.signed],
    description: "the request is signed with a different secret",
    apply: (wf) => code(wf, "Sign request", "const secret = $env.LAB_SIGNING_SECRET;", "const secret = 'not-the-signing-secret';"),
  },
  {
    id: "signed-no-timestamp-in-signature",
    workflow: "webhook-to-signed-api.json",
    tests: [T.signed],
    description: "the signature covers only the body, not timestamp.body",
    apply: (wf) => code(wf, "Sign request", ".update(`${timestamp}.${bodyString}`)", ".update(bodyString)"),
  },
  {
    id: "signed-body-differs-from-signed-bytes",
    workflow: "webhook-to-signed-api.json",
    tests: [T.signed],
    description: "the body that is sent differs from the bytes that were signed",
    apply: (wf) => param(wf, "Call signed API", "body", "$json.bodyString", "$json.bodyString + ' '"),
  },
  {
    id: "signed-swap-branch-outputs",
    workflow: "webhook-to-signed-api.json",
    tests: [T.signed],
    description: 'swap the true/false outputs of "Confident?"',
    apply: (wf) => swapOutputs(wf, "Confident?"),
  },
  {
    id: "signed-threshold-strict",
    workflow: "webhook-to-signed-api.json",
    tests: [T.signed],
    description: "confidence >= 0.8 becomes > 0.8",
    apply: (wf) => setIf(wf, "Confident?", "Number($json.confidence) > 0.8"),
  },
  {
    id: "signed-threshold-lowered",
    workflow: "webhook-to-signed-api.json",
    tests: [T.signed],
    description: "threshold lowered from 0.8 to 0.5",
    apply: (wf) => setIf(wf, "Confident?", "Number($json.confidence) >= 0.5"),
  },
  {
    id: "signed-no-review-queue",
    workflow: "webhook-to-signed-api.json",
    tests: [T.signed],
    description: "low confidence skips the review queue and goes straight to the callback",
    apply: (wf) => rewire(wf, "Confident?", 1, "Add to review queue", "Callback: needs review"),
  },
  {
    id: "signed-no-callback-on-auto",
    workflow: "webhook-to-signed-api.json",
    tests: [T.signed],
    description: "no callback for high-confidence events",
    apply: (wf) => dropEdge(wf, "Confident?", 0, "Callback: auto processed"),
  },
  {
    id: "signed-callback-allowlist-removed",
    workflow: "webhook-to-signed-api.json",
    tests: [T.signed],
    description: "callback URL allow-list removed (any host is accepted)",
    apply: (wf) => code(wf, "Validate event", "!callback_url.startsWith(ALLOWED_CALLBACK_PREFIX) || ", ""),
  },
  {
    id: "signed-no-failed-callback",
    workflow: "webhook-to-signed-api.json",
    tests: [T.signed],
    description: "a rejected or failed API call is silently dropped (no failed callback)",
    apply: (wf) => dropEdge(wf, "Call signed API", 1, "Callback: failed"),
  },
  // ---------------------------------------------------------------- retry / dedupe / error workflow
  {
    id: "retry-off",
    workflow: "retry-and-error-handling.json",
    tests: [T.retry],
    description: "retry on fail switched off",
    apply: (wf) => {
      const n = node(wf, "Call flaky API");
      if (n.retryOnFail !== true) throw new Error("mutant: retryOnFail was not set");
      n.retryOnFail = false;
    },
  },
  {
    id: "retry-max-tries-2",
    workflow: "retry-and-error-handling.json",
    tests: [T.retry],
    description: "max tries 3 -> 2 (the 3rd try never happens)",
    apply: (wf) => {
      const n = node(wf, "Call flaky API");
      if (n.maxTries !== 3) throw new Error("mutant: maxTries was not 3");
      n.maxTries = 2;
    },
  },
  {
    id: "retry-no-wait",
    workflow: "retry-and-error-handling.json",
    tests: [T.retry],
    description: "no wait between tries",
    apply: (wf) => {
      const n = node(wf, "Call flaky API");
      if (n.waitBetweenTries !== 1000) throw new Error("mutant: waitBetweenTries was not 1000");
      n.waitBetweenTries = 0;
    },
  },
  {
    id: "retry-no-request-timeout",
    workflow: "retry-and-error-handling.json",
    tests: [T.retry],
    description: "request timeout removed from the HTTP node",
    apply: (wf) => {
      const o = node(wf, "Call flaky API").parameters.options;
      if (!o.timeout) throw new Error("mutant: no timeout set");
      delete o.timeout;
    },
  },
  {
    id: "dedupe-removed",
    workflow: "retry-and-error-handling.json",
    tests: [T.retry],
    description: 'the dedupe check ("First delivery?") always passes',
    apply: (wf) => setIf(wf, "First delivery?", "true"),
  },
  {
    id: "dedupe-claim-never-done",
    workflow: "retry-and-error-handling.json",
    tests: [T.retry],
    description: 'a processed event stays "processing" in the claim table',
    apply: (wf) => param(wf, "Mark claim done", "jsonBody", "status: 'done'", "status: 'processing'"),
  },
  {
    id: "error-workflow-unlinked",
    workflow: "retry-and-error-handling.json",
    tests: [T.retry],
    description: "the Error Workflow link is removed from the workflow settings",
    apply: (wf) => {
      if (!wf.settings.errorWorkflow) throw new Error("mutant: no errorWorkflow set");
      delete wf.settings.errorWorkflow;
    },
  },
  {
    id: "failure-keeps-claim",
    workflow: "retry-and-error-handling.json",
    tests: [T.retry],
    description: "permanent failure does not release the claim",
    apply: (wf) => rewire(wf, "Call flaky API", 1, "Release claim", "Respond 502 failed"),
  },
  {
    id: "failure-not-an-error",
    workflow: "retry-and-error-handling.json",
    tests: [T.retry],
    description: 'permanent failure no longer fails the execution (no "Fail execution")',
    apply: (wf) => dropEdge(wf, "Respond 502 failed", 0, "Fail execution"),
  },
  {
    id: "alert-wrong-endpoint",
    workflow: "error-handler.json",
    tests: [T.retry],
    description: "the Error Workflow posts to the wrong alert URL",
    apply: (wf) => {
      const n = node(wf, "Post alert");
      n.parameters.url = replaceOnce(n.parameters.url, "/alerts", "/alert", "Post alert.url");
    },
  },
  {
    id: "alert-drops-event-id",
    workflow: "error-handler.json",
    tests: [T.retry],
    description: "the alert no longer extracts the event id",
    apply: (wf) => code(wf, "Format alert", "/Event ([A-Za-z0-9_-]{1,64}) failed/", "/Evnt ([A-Za-z0-9_-]{1,64}) failed/"),
  },
  // ---------------------------------------------------------------- scheduled digest
  {
    id: "digest-empty-day-sends",
    workflow: "scheduled-digest.json",
    tests: [T.digest],
    description: 'the "Anything to report?" check always passes (empty day sends a mail)',
    apply: (wf) => setIf(wf, "Anything to report?", "true"),
  },
  {
    id: "digest-flip-if",
    workflow: "scheduled-digest.json",
    tests: [T.digest],
    description: 'flip the "Anything to report?" condition',
    apply: (wf) => flipIf(wf, "Anything to report?"),
  },
  {
    id: "digest-no-pagination",
    workflow: "scheduled-digest.json",
    tests: [T.digest],
    description: "pagination removed (only the first 50 leads are read)",
    apply: (wf) => {
      const o = node(wf, "Fetch leads (all pages)").parameters.options;
      if (!o.pagination) throw new Error("mutant: no pagination set");
      delete o.pagination;
    },
  },
  {
    id: "digest-window-ten-days",
    workflow: "scheduled-digest.json",
    tests: [T.digest],
    description: "the digest window is 240 hours instead of 24",
    apply: (wf) => code(wf, "Compute window", "const WINDOW_HOURS = 24;", "const WINDOW_HOURS = 240;"),
  },
  {
    id: "digest-wrong-recipient",
    workflow: "scheduled-digest.json",
    tests: [T.digest],
    description: "the digest goes to a different address",
    apply: (wf) => code(wf, "Build digest", "leads-digest@n8n-lab.test", "digest@elsewhere.test"),
  },
  {
    id: "digest-pending-count",
    workflow: "scheduled-digest.json",
    tests: [T.digest],
    description: '"awaiting approval" counts the sent leads',
    apply: (wf) => code(wf, "Build digest", "const pending = by_status.pending || 0;", "const pending = by_status.sent || 0;"),
  },
  {
    id: "digest-top-list-ascending",
    workflow: "scheduled-digest.json",
    tests: [T.digest],
    description: "the top-by-fit list is sorted ascending",
    apply: (wf) => code(wf, "Build digest", "(b.fit_score || 0) - (a.fit_score || 0)", "(a.fit_score || 0) - (b.fit_score || 0)"),
  },
  {
    id: "digest-error-workflow-unlinked",
    workflow: "scheduled-digest.json",
    tests: [T.digest],
    description: "the Error Workflow link is removed from the digest workflow",
    apply: (wf) => {
      if (!wf.settings.errorWorkflow) throw new Error("mutant: no errorWorkflow set");
      delete wf.settings.errorWorkflow;
    },
  },
  {
    id: "digest-schedule-changed",
    workflow: "scheduled-digest.json",
    tests: [T.digest],
    description: "the schedule is 09:00 instead of 08:00",
    apply: (wf) => {
      const t = node(wf, "Schedule Trigger").parameters.rule.interval[0];
      t.expression = replaceOnce(t.expression, "0 8 * * *", "0 9 * * *", "Schedule Trigger");
    },
  },
  {
    id: "digest-timezone-utc",
    workflow: "scheduled-digest.json",
    tests: [T.digest],
    description: "the workflow time zone is UTC instead of Asia/Kolkata",
    apply: (wf) => {
      if (wf.settings.timezone !== "Asia/Kolkata") throw new Error("mutant: unexpected timezone");
      wf.settings.timezone = "UTC";
    },
  },
];

/** A change that does not alter behaviour: the runner must report it as SURVIVED. */
export const CONTROL_MUTANT = {
  id: "control-notes-only",
  workflow: "lead-approval-gate.json",
  tests: [T.lead],
  description: "CONTROL: only a node note changes, behaviour is identical (must survive)",
  apply: (wf) => {
    node(wf, "Validate lead").notes = "edited note (control mutant, no behaviour change)";
  },
};

// Workflow 1: lead in -> validate -> fit score -> draft -> store as pending ->
// (human) approve webhook -> send exactly once. Two variants: rules scorer / mock LLM.
import { Flow, codeFile, at } from "../lib/wfkit.mjs";
import { URLS } from "../lib/endpoints.mjs";

const T = URLS.tables;
const row = (id) => `'${T}/tables/leads/rows/' + ${id}`;
const approval = (field) => `$('Validate approval').first().json.${field}`;

export function buildLeadGate(variant) {
  const llm = variant === "llm";
  const suffix = llm ? "-llm" : "";
  const f = new Flow(llm ? "Lead approval gate (mock LLM scorer)" : "Lead approval gate (rules scorer)", {
    settings: { timezone: "UTC", saveDataErrorExecution: "all", saveDataSuccessExecution: "all" },
  });

  // ---------------------------------------------------------------- intake
  f.webhook("Webhook: lead intake", { path: `lead-intake${suffix}`, pos: at(0, 0) });
  f.code("Validate lead", codeFile("validate-lead.js"), at(1, 0));
  f.ifTrue("Lead valid?", "$json.valid === true", at(2, 0));
  f.respond("Respond 400 invalid lead", {
    code: 400,
    body: "{ error: 'invalid_lead', details: $json.errors }",
    pos: at(3, -1),
  });

  let beforeWrite;
  if (llm) {
    f.http("Ask LLM (mock)", {
      method: "POST",
      url: `${URLS.llm}/v1/chat/completions`,
      json:
        "{ model: 'mock-fit-1', response_format: { type: 'json_object' }, messages: [" +
        " { role: 'system', content: 'You qualify inbound B2B leads for a workflow automation consultancy. Reply with one JSON object with the keys fit_score (integer 0-100), rationale (string), draft_subject (string) and draft_body (string). Reply with nothing else.' }," +
        " { role: 'user', content: JSON.stringify($json.lead) } ] }",
      timeout: 8000,
      pos: at(3, 0),
      node: { onError: "continueRegularOutput" },
    });
    f.code("Parse LLM answer", codeFile("parse-llm.js"), at(4, 0), {
      note: "Takes the LLM answer only if it is valid JSON with a score in 0-100 and a draft; otherwise falls back to the rules scorer and says so in scored_by.",
    });
    f.connect("Lead valid?", "Ask LLM (mock)", 0).connect("Ask LLM (mock)", "Parse LLM answer");
    beforeWrite = "Parse LLM answer";
  } else {
    f.code("Score lead (rules)", codeFile("score-lead.js"), at(3, 0));
    f.code("Draft message", codeFile("draft-message.js"), at(4, 0));
    f.connect("Lead valid?", "Score lead (rules)", 0).connect("Score lead (rules)", "Draft message");
    beforeWrite = "Draft message";
  }
  f.connect("Lead valid?", "Respond 400 invalid lead", 1);

  f.http("Write lead (pending)", {
    method: "POST",
    url: `${T}/tables/leads/rows`,
    json:
      "{ name: $json.lead.name, email: $json.lead.email, company: $json.lead.company, title: $json.lead.title," +
      " employees: $json.lead.employees, budget_usd: $json.lead.budget_usd, message: $json.lead.message," +
      " fit_score: $json.fit_score, tier: $json.tier, reasons: $json.reasons, scored_by: $json.scored_by," +
      " fallback_reason: $json.fallback_reason || null, draft_subject: $json.draft_subject," +
      " draft_body: $json.draft_body, status: 'pending' }",
    timeout: 8000,
    pos: at(5, 0),
    node: { onError: "continueErrorOutput" },
  });
  f.respond("Respond 201 lead pending", {
    code: 201,
    body: "{ lead_id: $json.id, status: $json.status, fit_score: $json.fit_score, tier: $json.tier, scored_by: $json.scored_by }",
    pos: at(6, 0),
  });
  f.respond("Respond 502 storage unavailable", {
    code: 502,
    body: "{ error: 'storage_unavailable' }",
    pos: at(6, 1),
  });
  f.connect(beforeWrite, "Write lead (pending)")
    .connect("Write lead (pending)", "Respond 201 lead pending", 0)
    .connect("Write lead (pending)", "Respond 502 storage unavailable", 1);

  // --------------------------------------------------------------- approval
  const y = 3;
  f.webhook("Webhook: approve", { path: `lead-approve${suffix}`, pos: at(0, y) });
  f.code("Validate approval", codeFile("validate-approval.js"), at(1, y));
  f.ifTrue("Approval valid?", "$json.valid === true", at(2, y));
  f.respond("Respond 400 invalid approval", {
    code: 400,
    body: "{ error: 'invalid_approval', details: $json.errors }",
    pos: at(2, y + 1),
  });
  f.http("Get lead", { url: `={{ ${row("$json.lead_id")} }}`, full: true, timeout: 8000, pos: at(3, y) });
  f.ifTrue("Lead found?", "$json.statusCode === 200", at(4, y));
  f.respond("Respond lookup failed", {
    code: "={{ $json.statusCode === 404 ? 404 : 502 }}",
    body: `$json.statusCode === 404 ? { error: 'lead_not_found', lead_id: ${approval("lead_id")} } : { error: 'storage_unavailable' }`,
    pos: at(4, y + 1),
  });
  f.http("Claim for sending", {
    method: "PATCH",
    url: `={{ ${row(approval("lead_id"))} }}`,
    query: { if_status: "pending,send_failed" },
    json: `{ status: 'sending', approved_by: ${approval("approved_by")}, approved_at: $now.toISO() }`,
    full: true,
    timeout: 8000,
    pos: at(5, y),
  });
  f.ifTrue("Claim won?", "$json.statusCode === 200", at(6, y));
  f.respond("Respond not claimed", {
    code: "={{ $json.statusCode === 409 ? 409 : 502 }}",
    body: `$json.statusCode === 409 ? { error: 'already_processed', lead_id: ${approval("lead_id")}, status: $json.body.current_status } : { error: 'storage_unavailable' }`,
    pos: at(6, y + 1),
  });
  f.http("Send email", {
    method: "POST",
    url: `${URLS.email}/send`,
    headers: { "Idempotency-Key": "={{ $json.body.id }}" },
    json: "{ to: $json.body.email, subject: $json.body.draft_subject, body: $json.body.draft_body, lead_id: $json.body.id }",
    timeout: 8000,
    pos: at(7, y),
    node: { onError: "continueErrorOutput" },
  });
  f.http("Mark sent", {
    method: "PATCH",
    url: `={{ ${row(approval("lead_id"))} }}`,
    json: "{ status: 'sent', message_id: $json.message_id, sent_at: $now.toISO() }",
    timeout: 8000,
    pos: at(8, y),
  });
  f.respond("Respond 200 sent", {
    code: 200,
    body: "{ lead_id: $json.id, status: $json.status, message_id: $json.message_id }",
    pos: at(9, y),
  });
  f.http("Mark send_failed", {
    method: "PATCH",
    url: `={{ ${row(approval("lead_id"))} }}`,
    json: "{ status: 'send_failed', send_error: String(($json.error && $json.error.message) || 'send failed').slice(0, 200) }",
    timeout: 8000,
    pos: at(8, y + 1),
  });
  f.respond("Respond 502 send failed", {
    code: 502,
    body: "{ error: 'send_failed', lead_id: $json.id, status: $json.status }",
    pos: at(9, y + 1),
  });

  f.connect("Webhook: approve", "Validate approval")
    .connect("Validate approval", "Approval valid?")
    .connect("Approval valid?", "Get lead", 0)
    .connect("Approval valid?", "Respond 400 invalid approval", 1)
    .connect("Get lead", "Lead found?")
    .connect("Lead found?", "Claim for sending", 0)
    .connect("Lead found?", "Respond lookup failed", 1)
    .connect("Claim for sending", "Claim won?")
    .connect("Claim won?", "Send email", 0)
    .connect("Claim won?", "Respond not claimed", 1)
    .connect("Send email", "Mark sent", 0)
    .connect("Send email", "Mark send_failed", 1)
    .connect("Mark sent", "Respond 200 sent")
    .connect("Mark send_failed", "Respond 502 send failed");
  f.connect("Webhook: lead intake", "Validate lead").connect("Validate lead", "Lead valid?");
  return f;
}

// The "outside world" for the n8n workflows: eight small local HTTP services.
// Ports 4700-4707 on 127.0.0.1. Nothing here talks to a real service.
import crypto from "node:crypto";
import { createMock, sendJson } from "./lib.mjs";

export const PORTS = {
  tables: 4700, // stand-in for Airtable / a CRM table / a SQL REST layer
  email: 4701, // stand-in for Gmail / Smartlead / an ESP send API
  llm: 4702, // stand-in for a chat-completions LLM endpoint
  signed: 4703, // an API that requires an HMAC signature header
  callback: 4704, // the "callback URL" a caller gives us
  flaky: 4705, // fails 500 / hangs a scripted number of times
  alerts: 4706, // stand-in for Slack / PagerDuty
  outbox: 4707, // stand-in for the mail system that receives the digest
};

export const SIGNATURE_TOLERANCE_SECONDS = 300;

const FREE_MAIL = /@(gmail|yahoo|outlook|hotmail|proton|protonmail)\./i;
const KEYWORDS = ["automation", "n8n", "workflow", "integration", "crm", "api", "webhook"];

// ---------------------------------------------------------------- tables

function tablesMock(port) {
  const initialState = () => ({ tables: new Map(), counters: new Map() });
  const getTable = (state, name) => {
    if (!state.tables.has(name)) state.tables.set(name, new Map());
    return state.tables.get(name);
  };
  return createMock({
    name: "tables",
    port,
    initialState,
    async handler({ req, url, body, state }) {
      const m = url.pathname.match(/^\/tables\/([a-z_]+)\/rows(?:\/([A-Za-z0-9_.:-]+))?$/);
      if (!m) return { status: 404, body: { error: "not_found", path: url.pathname } };
      const [, tableName, id] = m;
      const table = getTable(state, tableName);

      if (req.method === "POST" && !id) {
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return { status: 400, body: { error: "body_must_be_object" } };
        }
        let rowId = body.id;
        if (rowId === undefined) {
          const n = (state.counters.get(tableName) ?? 0) + 1;
          state.counters.set(tableName, n);
          rowId = `${tableName.replace(/s$/, "")}_${n}`;
        }
        if (table.has(rowId)) {
          return {
            status: 409,
            body: { error: "duplicate_key", id: rowId, existing_status: table.get(rowId).status ?? null },
          };
        }
        const now = new Date().toISOString();
        const row = { created_at: now, ...body, id: rowId, updated_at: now };
        table.set(rowId, row);
        return { status: 201, body: row };
      }

      if (req.method === "GET" && id) {
        const row = table.get(id);
        return row ? { status: 200, body: row } : { status: 404, body: { error: "not_found", id } };
      }

      if (req.method === "GET" && !id) {
        const q = Object.fromEntries(url.searchParams);
        const pageSize = Math.min(Math.max(parseInt(q.page_size ?? "50", 10) || 50, 1), 100);
        const page = Math.max(parseInt(q.page ?? "1", 10) || 1, 1);
        const { created_after, created_before, page: _p, page_size: _s, ...equals } = q;
        let rows = [...table.values()].filter((r) => {
          if (created_after && !(r.created_at > created_after)) return false;
          if (created_before && !(r.created_at <= created_before)) return false;
          return Object.entries(equals).every(([k, v]) => String(r[k]) === v);
        });
        rows.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
        const total = rows.length;
        rows = rows.slice((page - 1) * pageSize, page * pageSize);
        return {
          status: 200,
          body: { rows, page, page_size: pageSize, total, has_more: page * pageSize < total },
        };
      }

      if (req.method === "PATCH" && id) {
        const row = table.get(id);
        if (!row) return { status: 404, body: { error: "not_found", id } };
        const ifStatus = url.searchParams.get("if_status");
        if (ifStatus && !ifStatus.split(",").includes(String(row.status))) {
          return {
            status: 409,
            body: { error: "precondition_failed", id, current_status: row.status },
          };
        }
        if (!body || typeof body !== "object") return { status: 400, body: { error: "body_must_be_object" } };
        const { id: _ignored, created_at: _c, ...patch } = body;
        Object.assign(row, patch, { updated_at: new Date().toISOString() });
        return { status: 200, body: row };
      }

      if (req.method === "DELETE" && id) {
        if (!table.delete(id)) return { status: 404, body: { error: "not_found", id } };
        return { status: 200, body: { deleted: id } };
      }
      return { status: 405, body: { error: "method_not_allowed" } };
    },
    async control({ url, state }) {
      // GET /__table/<name> -> full dump, handy in tests
      const m = url.pathname.match(/^\/__table\/([a-z_]+)$/);
      if (m) return { status: 200, body: { rows: [...getTable(state, m[1]).values()] } };
    },
  });
}

// ----------------------------------------------------------------- email

function emailMock(port) {
  return createMock({
    name: "email",
    port,
    initialState: () => ({ n: 0 }),
    async handler({ url, req, body, state }) {
      if (req.method !== "POST" || url.pathname !== "/send") {
        return { status: 404, body: { error: "not_found" } };
      }
      const { to, subject, body: text } = body ?? {};
      if (![to, subject, text].every((v) => typeof v === "string" && v.length > 0)) {
        return { status: 422, body: { error: "to, subject and body are required" } };
      }
      if (/@fail\.test$/i.test(to)) {
        return { status: 500, body: { error: "provider_unavailable" } };
      }
      state.n += 1;
      return { status: 200, body: { accepted: true, message_id: `msg_${state.n}` } };
    },
  });
}

// ------------------------------------------------------------------- llm
// A deterministic stand-in for a chat-completions endpoint. Not a model: the
// "fit score" below is arithmetic on the input, with different weights from
// the workflow's own rule-based scorer so tests can tell the two apart.

export function mockLlmFit(lead) {
  let s = 40;
  const title = String(lead.title ?? "").toLowerCase();
  if (/(founder|ceo|cto|chief|owner)/.test(title)) s += 25;
  else if (/(head|director|vp)/.test(title)) s += 15;
  const budget = Number(lead.budget_usd ?? 0);
  if (budget >= 5000) s += 20;
  else if (budget >= 1000) s += 10;
  const message = String(lead.message ?? "");
  if (message.length >= 60) s += 10;
  const found = KEYWORDS.filter((k) => message.toLowerCase().includes(k));
  s += Math.min(found.length, 3) * 4;
  if (FREE_MAIL.test(String(lead.email ?? ""))) s -= 15;
  s = Math.max(0, Math.min(100, s));
  const first = String(lead.name ?? "there").split(" ")[0];
  return {
    fit_score: s,
    rationale: `title=${title || "n/a"}, budget=${budget}, keywords=${found.join("+") || "none"}`,
    draft_subject: `Re: your enquiry about ${found[0] ?? "automation"}`,
    draft_body:
      `Hi ${first},\n\nThanks for getting in touch. From what you describe I can help ` +
      `with ${found.slice(0, 2).join(" and ") || "your automation"}. ` +
      `Could you share a bit more about the current setup?\n\nBest regards`,
  };
}

function llmMock(port) {
  return createMock({
    name: "llm",
    port,
    async handler({ req, url, body }) {
      if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return { status: 404, body: { error: "not_found" } };
      }
      const user = body?.messages?.find?.((m) => m.role === "user");
      let lead;
      try {
        lead = JSON.parse(user?.content ?? "");
      } catch {
        return { status: 400, body: { error: "user message must be a JSON lead" } };
      }
      const company = String(lead.company ?? "");
      if (company.includes("llm-down")) return { status: 503, body: { error: "overloaded" } };
      let content;
      if (company.includes("llm-garbage")) content = "Sure! I would say this lead is a great fit.";
      else if (company.includes("llm-outofrange")) {
        content = JSON.stringify({ ...mockLlmFit(lead), fit_score: 250 });
      } else content = JSON.stringify(mockLlmFit(lead));
      return {
        status: 200,
        body: {
          id: `mock-${Date.now()}`,
          model: body?.model ?? "mock-fit-1",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 120, completion_tokens: 80 },
        },
      };
    },
  });
}

// ---------------------------------------------------------------- signed

export function sign(secret, timestamp, rawBody) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function classify(text) {
  const t = String(text ?? "").toLowerCase();
  // fixtures for the exact edge of the workflow's 0.8 threshold
  if (t.includes("threshold-exact")) return { label: "boundary", confidence: 0.8 };
  if (t.includes("threshold-below")) return { label: "boundary", confidence: 0.79 };
  if (t.includes("refund")) return { label: "refund_request", confidence: 0.95 };
  if (t.includes("invoice") || t.includes("billing")) return { label: "billing", confidence: 0.88 };
  if (t.includes("password") || t.includes("login")) return { label: "account_access", confidence: 0.84 };
  if (t.includes("maybe")) return { label: "other", confidence: 0.55 };
  return { label: "other", confidence: 0.42 };
}

function signedMock(port, secret) {
  return createMock({
    name: "signed",
    port,
    async handler({ req, url, body, raw, rec }) {
      if (req.method !== "POST" || url.pathname !== "/v1/classify") {
        return { status: 404, body: { error: "not_found" } };
      }
      const ts = req.headers["x-lab-timestamp"];
      const sig = req.headers["x-lab-signature"];
      if (!ts || !sig) {
        rec.verification = { valid: false, reason: "missing_headers" };
        return { status: 401, body: { error: "missing_signature_headers" } };
      }
      const age = Math.abs(Date.now() / 1000 - Number(ts));
      if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) {
        rec.verification = { valid: false, reason: "stale_timestamp" };
        return { status: 401, body: { error: "stale_timestamp" } };
      }
      const expected = sign(secret, ts, raw);
      const a = Buffer.from(String(sig));
      const b = Buffer.from(expected);
      const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      rec.verification = { valid: ok, reason: ok ? "ok" : "bad_signature" };
      if (!ok) return { status: 401, body: { error: "bad_signature" } };
      if (typeof body?.text !== "string" || !body?.event_id) {
        return { status: 422, body: { error: "event_id and text required" } };
      }
      return {
        status: 200,
        body: { event_id: body.event_id, ...classify(body.text), model: "mock-classifier-1" },
      };
    },
  });
}

// ------------------------------------------------------------- recorders

function recorderMock(name, port, route, okStatus = 200) {
  return createMock({
    name,
    port,
    initialState: () => ({ n: 0 }),
    async handler({ req, url, state }) {
      if (req.method !== "POST" || url.pathname !== route) {
        return { status: 404, body: { error: "not_found" } };
      }
      state.n += 1;
      return { status: okStatus, body: { ok: true, id: `${name}_${state.n}` } };
    },
  });
}

function outboxMock(port) {
  return createMock({
    name: "outbox",
    port,
    initialState: () => ({ n: 0 }),
    async handler({ req, url, body, state }) {
      if (req.method !== "POST" || url.pathname !== "/outbox") {
        return { status: 404, body: { error: "not_found" } };
      }
      if (![body?.to, body?.subject, body?.body].every((v) => typeof v === "string" && v)) {
        return { status: 422, body: { error: "to, subject and body are required" } };
      }
      state.n += 1;
      return { status: 202, body: { queued: true, id: `mail_${state.n}` } };
    },
  });
}

// ----------------------------------------------------------------- flaky
// POST /v1/process {event_id, ...}. Behaviour per event id is scripted through
// POST /__script {event_id, steps:[...]}; each step is "ok", an HTTP status
// number (e.g. 500) or "hang". Attempt N uses steps[N-1]; once the list is used
// up the last step repeats. An event without a script always succeeds.
// "hang" holds the connection open (up to HANG_CAP_MS) and records whether the
// caller gave up (client_aborted) - that is how a timeout setting is observed.

export const HANG_CAP_MS = 9000;

function flakyMock(port) {
  return createMock({
    name: "flaky",
    port,
    initialState: () => ({ scripts: new Map(), attempts: new Map() }),
    async control({ url, body, state, req }) {
      if (url.pathname === "/__script" && req.method === "POST") {
        if (!body?.event_id || !Array.isArray(body.steps)) {
          return { status: 400, body: { error: "event_id and steps[] required" } };
        }
        state.scripts.set(body.event_id, body.steps);
        return { status: 200, body: { ok: true } };
      }
    },
    async handler({ req, res, url, body, state, rec }) {
      if (req.method !== "POST" || url.pathname !== "/v1/process") {
        return { status: 404, body: { error: "not_found" } };
      }
      const id = body?.event_id;
      if (!id) return { status: 422, body: { error: "event_id required" } };
      const attempt = (state.attempts.get(id) ?? 0) + 1;
      state.attempts.set(id, attempt);
      rec.attempt = attempt;
      const steps = state.scripts.get(id) ?? ["ok"];
      const step = steps[Math.min(attempt, steps.length) - 1];
      rec.step = step;
      if (step === "hang") {
        res.on("close", () => {
          if (!res.writableFinished) {
            rec.client_aborted = true;
            rec.response = { status: null, note: "client closed the connection before any reply" };
          }
        });
        setTimeout(() => {
          if (!res.writableEnded && !res.destroyed) {
            rec.response = { status: 504, note: "hang cap reached" };
            sendJson(res, 504, { error: "gateway_timeout" });
          }
        }, HANG_CAP_MS).unref();
        return undefined;
      }
      if (step === "ok") {
        return { status: 200, body: { ok: true, event_id: id, attempt, result: "processed" } };
      }
      return { status: Number(step), body: { error: "scripted_failure", attempt } };
    },
  });
}

// ------------------------------------------------------------------- all

export function createServices({ signingSecret }) {
  if (!signingSecret) throw new Error("signingSecret is required");
  const mocks = {
    tables: tablesMock(PORTS.tables),
    email: emailMock(PORTS.email),
    llm: llmMock(PORTS.llm),
    signed: signedMock(PORTS.signed, signingSecret),
    callback: recorderMock("callback", PORTS.callback, "/callback"),
    flaky: flakyMock(PORTS.flaky),
    alerts: recorderMock("alerts", PORTS.alerts, "/alerts", 202),
    outbox: outboxMock(PORTS.outbox),
  };
  return {
    mocks,
    async start() {
      await Promise.all(Object.values(mocks).map((m) => m.start()));
    },
    async stop() {
      await Promise.all(Object.values(mocks).map((m) => m.stop()));
    },
  };
}

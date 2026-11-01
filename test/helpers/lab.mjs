// Helpers shared by the test files: talk to the webhooks, the mocks and n8n's executions.
import fs from "node:fs";
import path from "node:path";
import { inject } from "vitest";
import { N8nClient, ROOT, SCRATCH } from "../../scripts/lib/stack.mjs";
import { PORTS } from "../../mocks/services.mjs";
import { waitFor } from "../../scripts/lib/proc.mjs";

export const lab = () => inject("lab");
export const client = () => {
  const l = lab();
  return new N8nClient({ apiKey: l.apiKey, base: l.n8nBase });
};
export const workflowId = (file) => lab().ids[file];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
/** A token that is unique per test run and per call: use it in emails and event ids. */
export const uniq = (prefix = "t") => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

// ---------------------------------------------------------------- webhooks

export async function hook(pathname, body, { raw, headers = {}, method = "POST", timeoutMs = 25_000 } = {}) {
  const t0 = Date.now();
  const res = await fetch(`${lab().n8nBase}/webhook/${pathname}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "GET" ? undefined : (raw ?? JSON.stringify(body)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, ms: Date.now() - t0 };
}

// ------------------------------------------------------------------- mocks

export function mock(name) {
  const port = PORTS[name];
  if (!port) throw new Error(`unknown mock ${name}`);
  const url = `http://127.0.0.1:${port}`;
  const j = async (p, init) => (await fetch(url + p, { signal: AbortSignal.timeout(10_000), ...init })).json();
  return {
    port,
    url,
    async requests(filter) {
      const { requests } = await j("/__requests");
      return filter ? requests.filter(filter) : requests;
    },
    reset: () => j("/__reset", { method: "POST" }),
    fault: (f) => j("/__fault", { method: "POST", body: JSON.stringify(f), headers: { "content-type": "application/json" } }),
    clearFaults: () => j("/__fault", { method: "POST", body: JSON.stringify({ clear: true }), headers: { "content-type": "application/json" } }),
    script: (event_id, steps) =>
      j("/__script", { method: "POST", body: JSON.stringify({ event_id, steps }), headers: { "content-type": "application/json" } }),
    async table(name) {
      return (await j(`/__table/${name}`)).rows;
    },
    async send(method, p, body) {
      const res = await fetch(url + p, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    },
  };
}

// -------------------------------------------------------------- executions

const FINISHED = new Set(["success", "error", "crashed", "canceled"]);

/** Remember which executions the tests looked into (counted in the run summary). */
export function noteAsserted(...execs) {
  try {
    fs.mkdirSync(SCRATCH, { recursive: true });
    const lines = execs.flat().map((e) => JSON.stringify({ id: String(e.id), workflowId: e.workflowId, mode: e.mode, status: e.status }));
    if (lines.length) fs.appendFileSync(path.join(SCRATCH, "asserted-executions.jsonl"), lines.join("\n") + "\n");
  } catch {}
}

export async function listExecutions(wfId, { limit = 100 } = {}) {
  const res = await client().api(`/executions?workflowId=${wfId}&includeData=true&limit=${limit}`);
  if (res.status !== 200) throw new Error(`executions list failed: HTTP ${res.status}`);
  return res.body.data;
}

export async function getExecution(id) {
  const res = await client().api(`/executions/${id}?includeData=true`);
  if (res.status !== 200) throw new Error(`execution ${id}: HTTP ${res.status}`);
  noteAsserted(res.body);
  return res.body;
}

export const runData = (exec) => exec.data?.resultData?.runData ?? {};
export const ranNodes = (exec) => Object.keys(runData(exec));
/** The json of every item a node emitted on one output, for one run of that node. */
export function nodeItems(exec, node, { run = 0, output = 0 } = {}) {
  const r = runData(exec)[node]?.[run];
  if (!r) throw new Error(`node "${node}" did not run (ran: ${ranNodes(exec).join(", ")})`);
  return (r.data?.main?.[output] ?? []).map((i) => i.json);
}
export const nodeRuns = (exec, node) => runData(exec)[node]?.length ?? 0;

/**
 * Wait for a finished execution of a workflow whose trigger node output matches `match`.
 * Returns the execution including its node data.
 */
export async function findExecution(wfId, { trigger, match, timeoutMs = 20_000, mode } = {}) {
  let found = null;
  await waitFor(
    async () => {
      const execs = await listExecutions(wfId, { limit: 60 });
      found = execs.find((e) => {
        if (!FINISHED.has(e.status)) return false;
        if (mode && e.mode !== mode) return false;
        if (!trigger) return match ? match(e) : true;
        const first = runData(e)[trigger]?.[0]?.data?.main?.[0]?.[0]?.json;
        return first ? match(first, e) : false;
      });
      return !!found;
    },
    { timeoutMs, intervalMs: 250, what: `an execution of ${wfId} matching your predicate` },
  );
  noteAsserted(found);
  return found;
}

/** All finished executions of a workflow matching `match` (does not wait). */
export async function executionsWhere(wfId, match) {
  return (await listExecutions(wfId, { limit: 100 })).filter((e) => FINISHED.has(e.status) && match(e));
}

// ---------------------------------------------------------------- evidence

/** When LAB_EVIDENCE_DIR is set, save a sanitised export of an execution (see scripts/lib/sanitize.mjs). */
export async function saveEvidence(name, exec, { workflow } = {}) {
  const manifestFile = path.join(SCRATCH, "evidence-manifest.json");
  const entry = { name, executionId: exec.id, workflowId: exec.workflowId, workflow, status: exec.status };
  fs.mkdirSync(SCRATCH, { recursive: true });
  let manifest = [];
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  } catch {}
  manifest = manifest.filter((m) => m.name !== name).concat(entry);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  const dir = process.env.LAB_EVIDENCE_DIR;
  if (!dir) return;
  const { sanitizeExecution } = await import("../../scripts/lib/sanitize.mjs");
  fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
  const clean = sanitizeExecution(exec, { secrets: [lab().signingSecret, lab().apiKey, lab().ownerPassword] });
  fs.writeFileSync(path.join(ROOT, dir, `${name}.json`), JSON.stringify(clean, null, 2) + "\n");
}

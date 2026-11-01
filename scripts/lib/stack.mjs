// Starts and stops the whole lab: the mock services (in this process) and a real
// n8n instance (a child process tree), and gets workflows into n8n through its
// public REST API. Used by the test suite, the mutation check and the evidence script.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServices, PORTS } from "../../mocks/services.mjs";
import { allWorkflows } from "../build-workflows.mjs";
import { ERROR_WORKFLOW_ID } from "../../src/lib/endpoints.mjs";
import { killTree, portFree, sleep, waitFor, waitPortFree } from "./proc.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA_DIR = path.join(ROOT, ".n8n-data");
export const SCRATCH = path.join(ROOT, ".scratch");
export const N8N_PORT = 5690;
export const BROKER_PORT = 4749; // n8n's internal task-runner broker; inside the lab's own port range
export const CLI_BROKER_PORT = 4748; // for one-off `n8n <command>` runs next to a live server
export const N8N_BASE = `http://127.0.0.1:${N8N_PORT}`;
const N8N_BIN = path.join(ROOT, "node_modules/n8n/bin/n8n");

export const secretsFile = (dataDir) => path.join(dataDir, "lab-secrets.json");
export function readSecrets(dataDir = DATA_DIR) {
  try {
    return JSON.parse(fs.readFileSync(secretsFile(dataDir), "utf8"));
  } catch {
    return null;
  }
}
function writeSecrets(dataDir, secrets) {
  fs.writeFileSync(secretsFile(dataDir), JSON.stringify(secrets, null, 2), { mode: 0o600 });
}

/** The node binary used for n8n. n8n 2.45.x needs Node >= 24; the system Node is used as is. */
export function nodeBinary() {
  return process.env.LAB_NODE || process.execPath;
}

export function n8nEnv({ dataDir, secrets, brokerPort = BROKER_PORT }) {
  const keep = ["PATH", "HOME", "TMPDIR", "LANG", "USER", "LOGNAME", "SHELL"];
  const env = Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  return {
    ...env,
    N8N_USER_FOLDER: dataDir,
    N8N_PORT: String(N8N_PORT),
    N8N_LISTEN_ADDRESS: "127.0.0.1",
    N8N_HOST: "127.0.0.1",
    N8N_PROTOCOL: "http",
    N8N_EDITOR_BASE_URL: N8N_BASE,
    N8N_WEBHOOK_URL: `${N8N_BASE}/`,
    N8N_SECURE_COOKIE: "false",
    // no telemetry, no update checks, no templates, no banners, no community-package lookups
    N8N_DIAGNOSTICS_ENABLED: "false",
    N8N_VERSION_NOTIFICATIONS_ENABLED: "false",
    N8N_TEMPLATES_ENABLED: "false",
    N8N_PERSONALIZATION_ENABLED: "false",
    N8N_HIRING_BANNER_ENABLED: "false",
    N8N_DYNAMIC_BANNERS_ENABLED: "false",
    N8N_AI_ENABLED: "false",
    N8N_COMMUNITY_PACKAGES_ENABLED: "false",
    N8N_UNVERIFIED_PACKAGES_ENABLED: "false",
    N8N_LICENSE_AUTO_RENEW_ENABLED: "false",
    // task runner (runs Code nodes) talks to n8n on a port inside the lab's range
    N8N_RUNNERS_MODE: "internal",
    N8N_RUNNERS_BROKER_PORT: String(brokerPort),
    N8N_RUNNERS_TASK_TIMEOUT: "60",
    // the Code node signs requests with the crypto module and reads the secret from the env
    N8N_BLOCK_ENV_ACCESS_IN_NODE: "false",
    NODE_FUNCTION_ALLOW_BUILTIN: "crypto",
    LAB_SIGNING_SECRET: secrets.signingSecret,
    EXECUTIONS_DATA_SAVE_ON_ERROR: "all",
    EXECUTIONS_DATA_SAVE_ON_SUCCESS: "all",
    EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS: "true",
    EXECUTIONS_DATA_PRUNE: "false",
    GENERIC_TIMEZONE: "UTC",
    TZ: "UTC",
    N8N_LOG_LEVEL: "info",
    N8N_LOG_OUTPUT: "console",
  };
}

// ---------------------------------------------------------------- n8n client

export class N8nClient {
  constructor({ apiKey, base = N8N_BASE }) {
    this.apiKey = apiKey;
    this.base = base;
    this.cookie = null;
  }

  async api(p, { method = "GET", body, signal } = {}) {
    const res = await fetch(`${this.base}/api/v1${p}`, {
      method,
      headers: { "X-N8N-API-KEY": this.apiKey, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }

  async login(secrets) {
    const res = await fetch(`${this.base}/rest/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emailOrLdapLoginId: secrets.ownerEmail, password: secrets.ownerPassword }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status !== 200) throw new Error(`owner login failed: HTTP ${res.status}`);
    this.cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    return this.cookie;
  }

  /** The editor's own "Execute workflow" call: runs the workflow from the given trigger node. */
  async runFromTrigger(workflowId, triggerName) {
    if (!this.cookie) throw new Error("login() first");
    const res = await fetch(`${this.base}/rest/workflows/${workflowId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: this.cookie },
      body: JSON.stringify({ triggerToStartFrom: { name: triggerName } }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }
}

// ------------------------------------------------------------------ n8n process

export async function assertPortsFree(ports) {
  for (const p of ports) {
    if (!(await portFree(p))) throw new Error(`port ${p} is already in use; refusing to start (is another lab instance running?)`);
  }
}

export async function startN8n({ dataDir = DATA_DIR, secrets, logFile, brokerPort = BROKER_PORT }) {
  await assertPortsFree([N8N_PORT, brokerPort]);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, "a");
  const child = spawn(nodeBinary(), [N8N_BIN, "start"], {
    cwd: ROOT,
    env: n8nEnv({ dataDir, secrets, brokerPort }),
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  let exited = null;
  child.on("exit", (code, sig) => (exited = { code, sig }));
  child.unref();
  // last resort if the parent dies without running stop() (for example on Ctrl-C): take the group down
  const onParentExit = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  process.on("exit", onParentExit);
  const handle = {
    pid: child.pid,
    logFile,
    async stop() {
      if (exited && !(await portFree(N8N_PORT))) {
        // our process is gone but something still listens: do not kill unknown processes
        throw new Error("n8n exited but port 5690 is still busy");
      }
      await killTree(child.pid, { graceMs: 8000 });
      process.off("exit", onParentExit);
      await waitPortFree(N8N_PORT, 10_000);
      await waitPortFree(brokerPort, 10_000);
    },
  };
  try {
    await waitFor(
      async () => {
        if (exited) throw new Error(`n8n exited early (${JSON.stringify(exited)}); see ${logFile}`);
        const r = await fetch(`${N8N_BASE}/healthz/readiness`, { signal: AbortSignal.timeout(2000) });
        return r.status === 200;
      },
      { timeoutMs: 180_000, intervalMs: 500, what: "n8n readiness" },
    );
  } catch (e) {
    await handle.stop().catch(() => {});
    throw e;
  }
  return handle;
}

/** Run a one-off n8n CLI command (stdout returned) next to or instead of a server. */
export function runN8nCli(args, { dataDir = DATA_DIR, secrets, timeoutMs = 120_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBinary(), [N8N_BIN, ...args], {
      cwd: ROOT,
      env: n8nEnv({ dataDir, secrets, brokerPort: CLI_BROKER_PORT }),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      killTree(child.pid, { graceMs: 1000 });
      reject(new Error(`n8n ${args[0]} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.on("exit", async (code) => {
      clearTimeout(timer);
      await killTree(child.pid, { graceMs: 1000 }); // sweep any leftover runner
      resolve({ code, out, err });
    });
  });
}

/** First run in an empty data folder: owner account + API key, kept only in that folder. */
export async function bootstrapOwner(secrets, dataDir) {
  const post = async (p, body, cookie) => {
    const res = await fetch(`${N8N_BASE}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (res.status >= 300) throw new Error(`POST ${p} -> HTTP ${res.status}`);
    return { res, json: JSON.parse(text) };
  };
  const { res } = await post("/rest/owner/setup", {
    email: secrets.ownerEmail,
    firstName: "Lab",
    lastName: "Owner",
    password: secrets.ownerPassword,
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const scopesRes = await fetch(`${N8N_BASE}/rest/api-keys/scopes`, { headers: { cookie } });
  const scopes = (await scopesRes.json()).data.filter((s) => /^(workflow|execution):/.test(s));
  const { json } = await post("/rest/api-keys", { label: "n8n-lab", scopes, expiresAt: null }, cookie);
  const next = { ...secrets, apiKey: json.data.rawApiKey };
  writeSecrets(dataDir, next);
  return next;
}

function freshSecrets() {
  return {
    ownerEmail: "owner@n8n-lab.test",
    ownerPassword: `Lab1-${crypto.randomBytes(12).toString("hex")}`,
    signingSecret: crypto.randomBytes(24).toString("hex"),
    apiKey: null,
  };
}

// ------------------------------------------------------------ workflow sync

const API_WORKFLOW_KEYS = ["name", "nodes", "connections", "settings"];

function webhookPaths(wf) {
  return wf.nodes.filter((n) => n.type === "n8n-nodes-base.webhook").map((n) => n.parameters.path);
}

async function webhookRegistered(p) {
  // A GET on a POST-only production webhook answers 404 with a "Did you mean" hint
  // once the path is registered, and a plain "not registered" before that.
  const res = await fetch(`${N8N_BASE}/webhook/${p}`, { signal: AbortSignal.timeout(5000) });
  const text = await res.text();
  return res.status === 404 && /Did you mean to make a POST/.test(text);
}

/**
 * Put every workflow from workflows/*.json (as built by build-workflows.mjs) into n8n,
 * activate the ones with triggers, wait until their webhooks answer.
 * `transform(fileName, json)` may return a modified copy (used for mutants).
 */
export async function syncWorkflows(client, { transform } = {}) {
  const existing = (await client.api("/workflows?limit=250")).body.data ?? [];
  const byName = new Map(existing.map((w) => [w.name, w]));
  const ids = {};
  const uploaded = {};
  let errorHandlerId = null;

  const entries = Object.entries(allWorkflows()).map(([file, flow]) => [file, JSON.parse(JSON.stringify(flow.toJSON()))]);
  // the error handler first, so the others can point at its real id
  entries.sort(([a], [b]) => (a === "error-handler.json" ? -1 : b === "error-handler.json" ? 1 : 0));

  for (const [file, original] of entries) {
    let wf = transform ? transform(file, JSON.parse(JSON.stringify(original))) : original;
    const body = Object.fromEntries(API_WORKFLOW_KEYS.map((k) => [k, wf[k]]));
    if (body.settings?.errorWorkflow === ERROR_WORKFLOW_ID) body.settings.errorWorkflow = errorHandlerId;
    const prev = byName.get(body.name);
    if (prev) {
      await client.api(`/workflows/${prev.id}/deactivate`, { method: "POST", body: {} });
    }
    const res = prev
      ? await client.api(`/workflows/${prev.id}`, { method: "PUT", body })
      : await client.api("/workflows", { method: "POST", body });
    if (res.status >= 300) throw new Error(`could not upload ${file}: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    const id = res.body.id;
    ids[file] = id;
    uploaded[file] = body;
    if (file === "error-handler.json") errorHandlerId = id;
    // n8n 2.x only calls an Error Workflow that is active (published), so activate all of them
    const act = await client.api(`/workflows/${id}/activate`, { method: "POST", body: {} });
    if (act.status >= 300 || act.body.active !== true) {
      throw new Error(`could not activate ${file}: HTTP ${act.status} ${JSON.stringify(act.body).slice(0, 300)}`);
    }
  }
  // read back and compare what n8n stored with what we sent
  for (const [file, id] of Object.entries(ids)) {
    const got = (await client.api(`/workflows/${id}`)).body;
    const sent = uploaded[file];
    const same =
      JSON.stringify(got.nodes.map((n) => [n.name, n.parameters, n.onError, n.retryOnFail, n.maxTries, n.waitBetweenTries])) ===
        JSON.stringify(sent.nodes.map((n) => [n.name, n.parameters, n.onError, n.retryOnFail, n.maxTries, n.waitBetweenTries])) &&
      JSON.stringify(got.connections) === JSON.stringify(sent.connections) &&
      (got.settings?.errorWorkflow ?? null) === (sent.settings?.errorWorkflow ?? null);
    if (!same) throw new Error(`n8n stored ${file} differently from what was uploaded`);
  }
  for (const [file, wf] of Object.entries(uploaded)) {
    for (const p of webhookPaths(wf)) {
      await waitFor(() => webhookRegistered(p), { timeoutMs: 30_000, intervalMs: 250, what: `webhook ${p} of ${file}` });
    }
  }
  return { ids, uploaded, errorHandlerId };
}

export async function deleteAllExecutions(client) {
  for (;;) {
    const page = await client.api("/executions?limit=250");
    const rows = page.body?.data ?? [];
    if (!rows.length) return;
    for (const e of rows) await client.api(`/executions/${e.id}`, { method: "DELETE" });
  }
}

// ---------------------------------------------------------------- whole stack

/**
 * Mocks + n8n + workflows. Options:
 *   dataDir   n8n user folder (default .n8n-data; created and bootstrapped if missing)
 *   transform see syncWorkflows
 *   logFile   where n8n writes its log
 */
export async function startStack({ dataDir = DATA_DIR, transform, logFile = path.join(SCRATCH, "n8n.log") } = {}) {
  await assertPortsFree(Object.values(PORTS));
  let secrets = readSecrets(dataDir);
  const dbFile = path.join(dataDir, ".n8n", "database.sqlite");
  const needsBootstrap = !secrets?.apiKey || !fs.existsSync(dbFile);
  if (needsBootstrap) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    secrets = freshSecrets();
    writeSecrets(dataDir, secrets);
  }
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, "");

  const services = createServices({ signingSecret: secrets.signingSecret });
  await services.start();
  let n8n = null;
  try {
    n8n = await startN8n({ dataDir, secrets, logFile });
    if (needsBootstrap) secrets = await bootstrapOwner(secrets, dataDir);
    const client = new N8nClient({ apiKey: secrets.apiKey });
    await client.login(secrets);
    const synced = await syncWorkflows(client, { transform });
    await deleteAllExecutions(client); // every run starts with an empty execution list
    return {
      secrets,
      services,
      mocks: services.mocks,
      n8n,
      client,
      dataDir,
      ids: synced.ids,
      errorHandlerId: synced.errorHandlerId,
      uploaded: synced.uploaded,
      logFile,
      async stop() {
        if (n8n) await n8n.stop();
        await services.stop();
      },
    };
  } catch (e) {
    if (n8n) await n8n.stop().catch(() => {});
    await services.stop().catch(() => {});
    throw e;
  }
}

export { sleep };

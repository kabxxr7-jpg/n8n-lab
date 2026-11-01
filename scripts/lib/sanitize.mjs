// Turns an execution as returned by n8n's API into something safe to commit:
// keeps the status, timings and every node's output, drops the embedded workflow
// source and engine internals, removes absolute paths and credential-like headers,
// and refuses to produce output that still contains a known secret.
import os from "node:os";
import { ROOT } from "./stack.mjs";

const DROP_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-n8n-api-key", "proxy-authorization"]);

export function sanitizeExecution(exec, { secrets = [] } = {}) {
  const run = exec.data?.resultData ?? {};
  const slim = {
    id: exec.id,
    workflowId: exec.workflowId,
    workflowName: exec.workflowData?.name ?? null,
    nodesInWorkflow: (exec.workflowData?.nodes ?? []).map((n) => ({ name: n.name, type: n.type })),
    mode: exec.mode,
    status: exec.status,
    finished: exec.finished,
    startedAt: exec.startedAt,
    stoppedAt: exec.stoppedAt,
    lastNodeExecuted: run.lastNodeExecuted ?? null,
    error: run.error ?? null,
    nodesRun: Object.keys(run.runData ?? {}),
    runData: run.runData ?? {},
  };
  let text = JSON.stringify(slim, (key, value) => {
    if (typeof key === "string" && DROP_HEADERS.has(key.toLowerCase())) return "[removed]";
    return value;
  });
  text = text.split(ROOT).join("<repo>").split(os.homedir()).join("<home>");
  for (const s of secrets.filter(Boolean)) {
    if (text.includes(s)) throw new Error("refusing to write evidence: a secret value is present in the execution data");
  }
  if (/\/Users\/[A-Za-z0-9._-]+/.test(text)) throw new Error("refusing to write evidence: an absolute home path remains");
  if (/eyJ[A-Za-z0-9_-]{20,}/.test(text)) throw new Error("refusing to write evidence: a JWT-like token is present");
  return JSON.parse(text);
}

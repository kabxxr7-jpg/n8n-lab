// Starts the mocks and a real n8n for the whole run (or attaches to an already
// running stack described by LAB_CONTEXT_FILE, which is what the mutation check does).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startStack, SCRATCH, N8N_BASE } from "../scripts/lib/stack.mjs";
import { killTree } from "../scripts/lib/proc.mjs";
import { waitForLoad } from "../scripts/lib/load.mjs";

export default async function setup(project) {
  if (process.env.LAB_CONTEXT_FILE) {
    project.provide("lab", JSON.parse(fs.readFileSync(process.env.LAB_CONTEXT_FILE, "utf8")));
    return async () => {};
  }
  await waitForLoad();
  fs.rmSync(path.join(SCRATCH, "asserted-executions.jsonl"), { force: true });
  const stack = await startStack({ logFile: path.join(SCRATCH, "n8n-test.log") });
  project.provide("lab", contextOf(stack));
  return async () => {
    summarizeAssertedExecutions();
    if (process.env.LAB_SCREENSHOTS) await runScreenshotProcess();
    await stack.stop();
  };
}

export function contextOf(stack) {
  return {
    n8nBase: N8N_BASE,
    apiKey: stack.secrets.apiKey,
    ownerEmail: stack.secrets.ownerEmail,
    ownerPassword: stack.secrets.ownerPassword,
    signingSecret: stack.secrets.signingSecret,
    ids: stack.ids,
    errorHandlerId: stack.errorHandlerId,
    n8nPid: stack.n8n.pid,
  };
}

function summarizeAssertedExecutions() {
  try {
    const rows = fs.readFileSync(path.join(SCRATCH, "asserted-executions.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const unique = new Map(rows.map((r) => [r.id, r]));
    const by = {};
    for (const r of unique.values()) by[r.status] = (by[r.status] ?? 0) + 1;
    const summary = { executionsAsserted: unique.size, byStatus: by };
    fs.writeFileSync(path.join(SCRATCH, "last-run-summary.json"), JSON.stringify(summary, null, 2));
    console.log(`n8n executions asserted on: ${unique.size} unique (${JSON.stringify(by)})`);
  } catch {}
}

// Playwright cannot run inside vitest's module runner, so the screenshots are a separate process.
async function runScreenshotProcess({ timeoutMs = 240_000 } = {}) {
  const script = fileURLToPath(new URL("../scripts/take-screenshots.mjs", import.meta.url));
  const child = spawn(process.execPath, [script], { stdio: "inherit" });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const timer = setTimeout(() => killTree(child.pid).catch(() => {}), timeoutMs);
  const code = await exited;
  clearTimeout(timer);
  await killTree(child.pid).catch(() => {}); // anything the child left behind (Chrome)
  if (code !== 0) console.error(`screenshots failed (exit ${code})`);
}

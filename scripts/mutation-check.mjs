// Mutation check: apply small bugs to copies of the workflow JSON, run the tests that are supposed to
// notice against a REAL n8n, and report which mutants were killed and which survived.
//
//   node scripts/mutation-check.mjs                run everything (baseline, controls, all mutants)
//   node scripts/mutation-check.mjs --only a,b     run only these mutant ids
//   node scripts/mutation-check.mjs --list         list the mutants
//   node scripts/mutation-check.mjs --selftest     prove the timeout really kills the whole process tree
//   options: --timeout-sec N (per mutant, default 300)  --no-report
//
// Each mutant runs in its own process tree (scripts/mutation-worker.mjs: its own n8n, mocks and
// vitest). If it exceeds the hard timeout the whole tree is killed. A TIMEOUT IS NOT A KILL: it is
// reported as its own outcome and fails the run.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORTS } from "../mocks/services.mjs";
import { waitForLoad } from "./lib/load.mjs";
import { CONTROL_MUTANT, MUTANTS } from "./lib/mutants.mjs";
import { isAlive, killTree, portFree, waitPortFree } from "./lib/proc.mjs";
import { BROKER_PORT, DATA_DIR, N8N_PORT, readSecrets, ROOT, SCRATCH, startStack } from "./lib/stack.mjs";

const OUT = path.join(SCRATCH, "mutation");
const ALL_PORTS = [N8N_PORT, BROKER_PORT, ...Object.values(PORTS)];

/** Spawn a command in its own process group; kill the whole tree if it runs past timeoutMs. */
export async function runWithTimeout({ command, args, env = process.env, cwd = ROOT, timeoutMs, logFile }) {
  const fd = fs.openSync(logFile, "w");
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  let timedOut = false;
  let tree = [child.pid];
  let killing = null;
  const exit = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const timer = setTimeout(() => {
    timedOut = true;
    killing = killTree(child.pid, { graceMs: 2000 }); // collects the whole tree first, then signals it
  }, timeoutMs);
  const { code, signal } = await exit;
  clearTimeout(timer);
  if (timedOut) {
    tree = await killing; // wait until every pid of the tree is gone (or SIGKILLed)
  } else {
    // the command ended on its own; sweep anything it left behind anyway
    await killTree(child.pid, { graceMs: 1000 });
  }
  return { timedOut, code, signal, tree };
}

export function tally(results) {
  const by = (s) => results.filter((r) => r.status === s).length;
  return { total: results.length, killed: by("killed"), survived: by("survived"), timeout: by("timeout"), error: by("error") };
}

async function runMutant(id, { timeoutSec, tests = [], extraEnv = {} }) {
  fs.mkdirSync(OUT, { recursive: true });
  const resultFile = path.join(OUT, `${id}.result.json`);
  fs.rmSync(`${resultFile}.hanging`, { force: true });
  const dataCopy = path.join(SCRATCH, `mutant-data-${id}`);
  fs.rmSync(resultFile, { force: true });
  const t0 = Date.now();
  const run = await runWithTimeout({
    command: process.execPath,
    args: [path.join(ROOT, "scripts/mutation-worker.mjs"), id, resultFile, dataCopy, ...tests],
    env: { ...process.env, ...extraEnv },
    timeoutMs: timeoutSec * 1000,
    logFile: path.join(OUT, `${id}.worker.log`),
  });
  fs.rmSync(dataCopy, { recursive: true, force: true });
  // nothing of this mutant may be left running
  const stillAlive = run.tree.filter(isAlive);
  let result;
  if (run.timedOut) {
    result = { id, status: "timeout", message: `no result after ${timeoutSec} s; process tree of ${run.tree.length} pids killed` };
  } else {
    try {
      result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    } catch {
      result = { id, status: "error", message: `worker exited (${run.code ?? run.signal}) without a result` };
    }
  }
  const busy = [];
  for (const p of ALL_PORTS) if (!(await waitPortFree(p, 8000))) busy.push(p);
  if (stillAlive.length || busy.length) {
    result = {
      ...result,
      status: "error",
      message: `leftovers after the mutant: pids ${stillAlive.join(",") || "none"}, busy ports ${busy.join(",") || "none"}`,
      leaked: true,
    };
  }
  return { ...result, id, wallSec: Math.round((Date.now() - t0) / 1000), pidsKilled: run.timedOut ? run.tree.length : undefined };
}

async function bootstrapIfNeeded() {
  if (readSecrets()?.apiKey && fs.existsSync(path.join(DATA_DIR, ".n8n", "database.sqlite"))) return;
  console.log("first run: creating the local n8n data folder (owner + API key) ...");
  const s = await startStack();
  await s.stop();
}

// ------------------------------------------------------------------ selftest

async function selftest() {
  fs.mkdirSync(OUT, { recursive: true });
  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  };

  // 1. a planted hang with grandchildren, one of them in its own process group
  const hang = `
    const { spawn } = require('node:child_process');
    spawn('sleep', ['600'], { stdio: 'ignore' });
    spawn('sleep', ['600'], { stdio: 'ignore', detached: true });
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    setInterval(() => {}, 1000);
  `;
  const t0 = Date.now();
  const toy = await runWithTimeout({ command: process.execPath, args: ["-e", hang], timeoutMs: 3000, logFile: path.join(OUT, "selftest-toy.log") });
  check("a planted hang is reported as timed out", toy.timedOut === true);
  check("it was stopped at about the timeout, not after the hang", Date.now() - t0 < 12_000, `${Date.now() - t0} ms`);
  check("the tree had the parent and 3 grandchildren", toy.tree.length >= 4, `${toy.tree.length} pids`);
  check("every process in the tree is dead (including the one in its own process group)", toy.tree.every((p) => !isAlive(p)));

  // 2. a timeout is not a kill
  const t = tally([{ status: "killed" }, { status: "killed" }, { status: "survived" }, { status: "timeout" }, { status: "error" }]);
  check("a timeout is counted separately from kills", t.killed === 2 && t.timeout === 1 && t.survived === 1 && t.error === 1);

  // 3. the same with the real stack: n8n + task runner + mocks + vitest-sized process tree
  if (!process.argv.includes("--selftest-quick")) {
    await bootstrapIfNeeded();
    await waitForLoad();
    const r = await runMutant("__selftest_hang__", { timeoutSec: 60 });
    const marker = path.join(OUT, "__selftest_hang__.result.json.hanging");
    check("the stack was really up (n8n, task runner, mocks) when the hang was killed", fs.existsSync(marker) && (r.pidsKilled ?? 0) >= 4, `${r.pidsKilled} pids in the killed tree`);
    check("a hang with the full stack (n8n, task runner, mocks) is reported as a timeout", r.status === "timeout", r.message ?? "");
    check("the whole stack was killed: n8n/mock ports are free and no pid is left", r.leaked !== true && r.status === "timeout", `${r.pidsKilled} pids killed`);
    check("n8n's port 5690 is free again", await portFree(N8N_PORT));
  }

  // 4. the runner can tell a harmless change (survives) from a real bug (killed): see the controls in a full run
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nselftest: ${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

// ---------------------------------------------------------------------- main

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  if (process.argv.includes("--list")) {
    for (const m of MUTANTS) console.log(`${m.id.padEnd(40)} ${m.workflow.padEnd(32)} ${m.description}`);
    console.log(`${MUTANTS.length} mutants (+ 1 control)`);
    return;
  }
  if (process.argv.includes("--selftest")) return selftest();

  const timeoutSec = Number(arg("--timeout-sec", 300));
  const only = arg("--only")?.split(",");
  const list = only ? MUTANTS.filter((m) => only.includes(m.id)) : MUTANTS;
  if (only && list.length !== only.length) throw new Error(`unknown mutant id in --only (known: ${MUTANTS.map((m) => m.id).join(", ")})`);

  for (const p of ALL_PORTS) if (!(await portFree(p))) throw new Error(`port ${p} is busy; stop whatever uses it first`);
  await bootstrapIfNeeded();

  const results = [];
  const started = Date.now();
  const step = async (m, label) => {
    await waitForLoad();
    process.stdout.write(`${label.padEnd(9)} ${m.id.padEnd(40)} `);
    const r = await runMutant(m.id, { timeoutSec });
    results.push({ ...r, workflow: m.workflow, description: m.description, control: m === CONTROL_MUTANT, baseline: m.id === "__baseline__" });
    console.log(`${r.status.toUpperCase().padEnd(9)} ${String(r.wallSec).padStart(4)} s  ${r.failedNames?.[0] ?? r.message ?? ""}`.trimEnd());
    return r;
  };

  // baseline: the unmodified workflows must pass the very same way, or kills mean nothing
  const baselineTests = [...new Set(MUTANTS.flatMap((m) => m.tests))];
  await waitForLoad();
  process.stdout.write(`${"baseline".padEnd(9)} ${"(no mutation)".padEnd(40)} `);
  const base = await runMutant("__baseline__", { timeoutSec: timeoutSec * 2, tests: baselineTests });
  console.log(`${base.status.toUpperCase()} ${base.total ?? "?"} tests, ${base.failed ?? "?"} failed, ${base.wallSec} s`);
  if (base.status !== "survived") {
    console.error("The unmodified workflows do not pass the tests; mutation results would be meaningless.", base.failedNames ?? base.message);
    process.exit(2);
  }

  const control = await step(CONTROL_MUTANT, "control");
  for (const m of list) await step(m, "mutant");

  const real = results.filter((r) => !r.control);
  const t = tally(real);
  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  console.log(
    `\nmutants: ${t.total}  killed: ${t.killed}  survived: ${t.survived}  timeout: ${t.timeout}  error: ${t.error}  ` +
      `(control mutant ${control.status === "survived" ? "survived as expected" : `WRONG outcome: ${control.status}`}; ${minutes} min)`,
  );
  for (const r of real.filter((x) => x.status !== "killed")) console.log(`  not killed: ${r.id} [${r.status}] ${r.message ?? r.description}`);

  if (!process.argv.includes("--no-report") && !only) writeReport({ real, control, base, t, minutes, timeoutSec });
  const bad = t.survived + t.timeout + t.error > 0 || control.status !== "survived";
  process.exit(bad ? 1 : 0);
}

function writeReport({ real, control, base, t, minutes, timeoutSec }) {
  const dir = path.join(ROOT, "evidence");
  fs.mkdirSync(dir, { recursive: true });
  const slim = (r) => ({
    id: r.id,
    workflow: r.workflow,
    change: r.description,
    outcome: r.status,
    testsFailed: r.failed ?? null,
    firstFailingTest: r.failedNames?.[0] ?? null,
    seconds: r.wallSec,
  });
  const json = {
    n8nVersion: JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules/n8n/package.json"), "utf8")).version,
    ranAt: new Date().toISOString(),
    perMutantTimeoutSeconds: timeoutSec,
    totalMinutes: Number(minutes),
    baseline: { tests: base.total, failed: base.failed },
    summary: t,
    control: slim(control),
    mutants: real.map(slim),
  };
  fs.writeFileSync(path.join(dir, "mutation-report.json"), JSON.stringify(json, null, 2) + "\n");
  const rows = real.map((r) => `| \`${r.id}\` | ${r.description.replace(/\|/g, "\\|")} | ${r.status} | ${r.failed ?? ""} | ${(r.failedNames?.[0] ?? "").replace(/\|/g, "\\|")} |`);
  const md = [
    "# Mutation check report",
    "",
    `n8n ${json.n8nVersion}, ${t.total} mutants, **${t.killed} killed**, ${t.survived} survived, ${t.timeout} timed out, ${t.error} errors. Whole run: ${minutes} minutes.`,
    `Baseline (unmodified workflows): ${base.total} tests, ${base.failed} failed. Control mutant (a note edit, no behaviour change): ${control.status}.`,
    "",
    "| Mutant | Change | Outcome | Tests failed | First failing test |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "mutation-report.md"), md);
  console.log("wrote evidence/mutation-report.md and .json");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}

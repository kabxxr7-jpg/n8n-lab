// One mutant, start to finish, in its own process tree (the parent kills the whole tree on timeout):
//   copy the n8n data folder -> start mocks + a real n8n -> upload the workflows with ONE of them
//   mutated -> run the vitest files that should notice -> write a result file -> stop everything.
// Usage: node scripts/mutation-worker.mjs <mutantId|__baseline__|__selftest_hang__> <resultFile> <dataCopyDir> [testFile...]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CONTROL_MUTANT, MUTANTS } from "./lib/mutants.mjs";
import { DATA_DIR, ROOT, SCRATCH, startStack } from "./lib/stack.mjs";
import { contextOf } from "../test/global-setup.mjs";

const [, , id, resultFile, dataCopy, ...extraTests] = process.argv;
const started = Date.now();
const write = (r) => fs.writeFileSync(resultFile, JSON.stringify({ id, durationMs: Date.now() - started, ...r }, null, 2));

const isSpecial = id.startsWith("__");
const mutant = isSpecial ? null : [...MUTANTS, CONTROL_MUTANT].find((m) => m.id === id);
if (!isSpecial && !mutant) {
  write({ status: "error", message: `unknown mutant ${id}` });
  process.exit(2);
}

let stack = null;
try {
  fs.rmSync(dataCopy, { recursive: true, force: true });
  fs.cpSync(DATA_DIR, dataCopy, { recursive: true });

  let applied = false;
  const transform = (file, wf) => {
    if (!mutant || file !== mutant.workflow) return wf;
    const before = JSON.stringify(wf);
    mutant.apply(wf);
    if (JSON.stringify(wf) === before) throw new Error("the mutant did not change the workflow");
    applied = true;
    return wf;
  };
  stack = await startStack({ dataDir: dataCopy, transform, logFile: path.join(SCRATCH, "mutation", `${id}.n8n.log`) });
  if (mutant && !applied) throw new Error(`mutant target ${mutant.workflow} was never uploaded`);

  if (id === "__selftest_hang__") {
    // plant a hang with the full stack (n8n, task runner, mocks) alive: the parent must kill all of it
    spawn("sleep", ["600"], { stdio: "ignore" });
    fs.writeFileSync(`${resultFile}.hanging`, String(process.pid));
    await new Promise(() => {});
  }

  const ctxFile = path.join(SCRATCH, "mutation", `${id}.context.json`);
  fs.writeFileSync(ctxFile, JSON.stringify(contextOf(stack)), { mode: 0o600 });
  const reportFile = path.join(SCRATCH, "mutation", `${id}.vitest.json`);
  fs.rmSync(reportFile, { force: true });
  const tests = mutant ? mutant.tests : extraTests;
  const logFd = fs.openSync(path.join(SCRATCH, "mutation", `${id}.vitest.log`), "w");
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "node_modules/vitest/vitest.mjs"), "run", ...tests, "--reporter=json", `--outputFile=${reportFile}`],
    { cwd: ROOT, env: { ...process.env, LAB_CONTEXT_FILE: ctxFile }, stdio: ["ignore", logFd, logFd] },
  );
  const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
  fs.closeSync(logFd);

  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  } catch {}
  if (!report) {
    write({ status: "error", message: `vitest produced no report (exit ${code})` });
  } else {
    const failed = report.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === "failed").map((a) => a.fullName));
    const status = failed.length > 0 ? "killed" : code === 0 ? "survived" : "error";
    write({
      status,
      message: status === "error" ? `vitest exited ${code} without failed tests` : undefined,
      total: report.numTotalTests,
      passed: report.numPassedTests,
      failed: report.numFailedTests,
      failedNames: failed.slice(0, 5),
    });
  }
} catch (e) {
  write({ status: "error", message: String(e?.message ?? e).slice(0, 500) });
} finally {
  if (stack) await stack.stop().catch((e) => console.error("stop failed:", e.message));
  fs.rmSync(dataCopy, { recursive: true, force: true });
}

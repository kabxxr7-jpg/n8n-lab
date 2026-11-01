// Proves the exported JSON in workflows/ imports with n8n's OWN CLI (no API, no harness) into an empty
// n8n data folder, keeps the Error Workflow link, and that n8n can export it back.
//   npm run verify:cli-import
import fs from "node:fs";
import path from "node:path";
import { allWorkflows } from "./build-workflows.mjs";
import { ERROR_WORKFLOW_ID } from "../src/lib/endpoints.mjs";
import { ROOT, runN8nCli, SCRATCH } from "./lib/stack.mjs";

const dir = path.join(SCRATCH, "cli-import-data");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const secrets = { signingSecret: "cli-import-check" };
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const imp = await runN8nCli(["import:workflow", "--separate", `--input=${path.join(ROOT, "workflows")}`], { dataDir: dir, secrets, timeoutMs: 240_000 });
check("n8n import:workflow exits 0", imp.code === 0, `exit ${imp.code}`);

const list = await runN8nCli(["list:workflow"], { dataDir: dir, secrets });
const lines = list.out.split("\n").filter((l) => l.includes("|"));
const names = lines.map((l) => l.split("|")[1]);
const expected = Object.values(allWorkflows()).map((f) => f.name);
check("all six workflows are in the database", expected.every((n) => names.includes(n)), `${lines.length} listed`);
check("the error handler kept its fixed id", lines.some((l) => l.startsWith(`${ERROR_WORKFLOW_ID}|`)));

const exp = await runN8nCli(["export:workflow", "--all", "--pretty"], { dataDir: dir, secrets });
let exported = [];
try {
  exported = JSON.parse(exp.out.slice(exp.out.indexOf("[")));
} catch {}
check("n8n exports them back", exported.length === expected.length, `${exported.length} exported`);
const link = exported.find((w) => w.name === "Retry, dedupe and error handling")?.settings?.errorWorkflow;
check("the Error Workflow link survives the import", link === ERROR_WORKFLOW_ID, String(link));
const nodeCountsMatch = Object.values(allWorkflows()).every((f) => exported.find((w) => w.name === f.name)?.nodes.length === f.nodes.length);
check("every workflow has the same number of nodes after the round trip", nodeCountsMatch);

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nCLI import verified");
process.exit(failures ? 1 : 0);

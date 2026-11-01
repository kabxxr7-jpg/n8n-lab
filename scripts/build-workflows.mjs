// Generates workflows/*.json from src/workflows/*.mjs.
//   node scripts/build-workflows.mjs          write the files
//   node scripts/build-workflows.mjs --check  exit 1 if the committed files are stale
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stableStringify } from "../src/lib/wfkit.mjs";
import { buildLeadGate } from "../src/workflows/lead-approval-gate.mjs";
import { buildSignedApi } from "../src/workflows/webhook-to-signed-api.mjs";
import { buildRetryFlow, buildErrorWorkflow } from "../src/workflows/retry-and-error-handling.mjs";
import { buildDigest } from "../src/workflows/scheduled-digest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function allWorkflows() {
  return {
    "lead-approval-gate.json": buildLeadGate("rules"),
    "lead-approval-gate-llm.json": buildLeadGate("llm"),
    "webhook-to-signed-api.json": buildSignedApi(),
    "retry-and-error-handling.json": buildRetryFlow(),
    "error-handler.json": buildErrorWorkflow(),
    "scheduled-digest.json": buildDigest(),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [file, flow] of Object.entries(allWorkflows())) {
    const target = path.join(root, "workflows", file);
    const text = stableStringify(flow.toJSON());
    if (check) {
      const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
      if (current !== text) {
        stale++;
        console.error(`stale: workflows/${file}`);
      }
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
      console.log(`wrote workflows/${file} (${flow.nodes.length} nodes)`);
    }
  }
  if (check && stale) process.exit(1);
}

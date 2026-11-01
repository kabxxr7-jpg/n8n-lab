// Start the lab by hand: mocks + n8n on http://127.0.0.1:5690 with the four workflows loaded.
// Ctrl-C stops everything. The owner login for the editor is kept in .n8n-data/lab-secrets.json
// (git-ignored); this script never prints it.
import path from "node:path";
import { SCRATCH, startStack } from "./lib/stack.mjs";

const stack = await startStack({ logFile: path.join(SCRATCH, "n8n-manual.log") });
console.log("n8n editor:  http://127.0.0.1:5690   (log: .scratch/n8n-manual.log)");
console.log("webhooks:    POST http://127.0.0.1:5690/webhook/{lead-intake,lead-approve,lead-intake-llm,lead-approve-llm,signed-intake,events}");
console.log("mock ports:  4700-4707");
console.log("Press Ctrl-C to stop.");
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    await stack.stop();
    process.exit(0);
  });
}
await new Promise(() => {});

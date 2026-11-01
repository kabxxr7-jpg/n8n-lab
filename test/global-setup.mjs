// Starts the mocks and a real n8n for the whole run (or attaches to an already
// running stack described by LAB_CONTEXT_FILE, which is what the mutation check does).
import fs from "node:fs";
import path from "node:path";
import { startStack, SCRATCH, N8N_BASE } from "../scripts/lib/stack.mjs";
import { waitForLoad } from "../scripts/lib/load.mjs";

export default async function setup(project) {
  if (process.env.LAB_CONTEXT_FILE) {
    project.provide("lab", JSON.parse(fs.readFileSync(process.env.LAB_CONTEXT_FILE, "utf8")));
    return async () => {};
  }
  await waitForLoad();
  const stack = await startStack({ logFile: path.join(SCRATCH, "n8n-test.log") });
  project.provide("lab", contextOf(stack));
  return async () => {
    if (process.env.LAB_SCREENSHOTS) {
      const { takeScreenshots } = await import("../scripts/lib/screenshots.mjs");
      await takeScreenshots(stack).catch((e) => console.error("screenshots failed:", e.message));
    }
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
  };
}

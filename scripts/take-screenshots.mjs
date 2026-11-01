// Renders the recorded executions of a RUNNING stack in the n8n editor and saves PNGs.
// Run as its own process (the test runner calls it at the end of `npm run evidence`): inside
// vitest's module runner Playwright's stack-trace capture breaks ("code.charCodeAt is not a function").
import { N8nClient, readSecrets } from "./lib/stack.mjs";
import { takeScreenshots } from "./lib/screenshots.mjs";

const secrets = readSecrets();
if (!secrets?.apiKey) throw new Error("no local n8n data folder yet; run the tests first");
const client = new N8nClient({ apiKey: secrets.apiKey });
await client.login(secrets);
const taken = await takeScreenshots({ client, secrets });
if (taken.length === 0) throw new Error("no screenshots were taken");

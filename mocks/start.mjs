// Run just the mock services (ports 4700-4707) so you can poke at them by hand:
//   npm run mocks
import { createServices, PORTS } from "./services.mjs";

const services = createServices({ signingSecret: process.env.LAB_SIGNING_SECRET || "dev-only-signing-secret" });
await services.start();
console.log("mock services listening on 127.0.0.1:", JSON.stringify(PORTS));
console.log("each one also has GET /__requests, POST /__reset, POST /__fault, GET /__health");
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await services.stop();
    process.exit(0);
  });
}

// Optional politeness for shared machines: wait until the 1-minute load average
// is below LAB_MAX_LOAD (unset = do not wait).
import os from "node:os";
import { sleep } from "./proc.mjs";

export async function waitForLoad({
  max = Number(process.env.LAB_MAX_LOAD),
  maxWaitMs = 20 * 60_000,
  log = console.error,
} = {}) {
  if (!Number.isFinite(max) || max <= 0) return;
  const end = Date.now() + maxWaitMs;
  while (os.loadavg()[0] >= max) {
    if (Date.now() > end) {
      log(`load average still ${os.loadavg()[0].toFixed(1)} after ${Math.round(maxWaitMs / 60000)} min; continuing`);
      return;
    }
    log(`load average ${os.loadavg()[0].toFixed(1)} >= ${max}; waiting 60 s`);
    await sleep(60_000);
  }
}

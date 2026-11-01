// Renders recorded executions in the n8n editor with the locally installed Google Chrome
// (Playwright, channel "chrome", headless) and saves PNGs. Needs a running stack.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { killTree } from "./proc.mjs";
import { N8N_BASE, ROOT, SCRATCH } from "./stack.mjs";

const WANTED = [
  ["lead-gate-approve-sent", "Lead approval gate: approve webhook, lead sent once"],
  ["retry-permanent-failure", "Retry and error handling: three failed tries, execution fails, Error Workflow fires"],
  ["signed-api-low-confidence", "Signed API: low confidence goes to the review queue"],
  ["digest-sent", "Scheduled digest: all pages read, digest mailed"],
];

// Playwright does not expose the browser pid for a channel launch, so find the Chrome processes it
// started by their throwaway profile folder and make sure none outlive the run.
function playwrightChromePids() {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return out
      .split("\n")
      .filter((l) => l.includes("playwright_chromiumdev_profile"))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter(Number.isInteger);
  } catch {
    return [];
  }
}

// n8n opens a "Production Checklist" popover on published workflows; close it so it does not cover the canvas.
async function dismissChecklist(page) {
  const popover = page.getByText("Production Checklist", { exact: true });
  if (!(await popover.isVisible().catch(() => false))) return;
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  if (await popover.isVisible().catch(() => false)) {
    const box = await popover.boundingBox();
    // the close icon sits at the right-hand end of the popover's title row
    if (box) await page.mouse.click(box.x + 320, box.y + box.height / 2);
    await page.waitForTimeout(500);
  }
  if (await popover.isVisible().catch(() => false)) throw new Error("could not close the Production Checklist popover");
  await page.waitForTimeout(500);
}

export async function takeScreenshots(stack, { outDir = path.join(ROOT, "evidence", "screenshots") } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(SCRATCH, "evidence-manifest.json"), "utf8"));
  fs.mkdirSync(outDir, { recursive: true });
  const cookie = stack.client.cookie ?? (await stack.client.login(stack.secrets));
  const [cookieName, ...rest] = cookie.split(";")[0].split("=");
  const before = new Set(playwrightChromePids());
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const taken = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    await context.addCookies([{ name: cookieName, value: rest.join("="), url: N8N_BASE }]);
    for (const [name] of WANTED) {
      const entry = manifest.find((m) => m.name === name);
      if (!entry) continue;
      const page = await context.newPage();
      await page.goto(`${N8N_BASE}/workflow/${entry.workflowId}/executions/${entry.executionId}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".vue-flow__node, [data-test-id='canvas-node']", { timeout: 30_000 });
      await page.waitForTimeout(2500); // let the canvas fit and the run markers render
      await dismissChecklist(page);
      const file = path.join(outDir, `${name}.png`);
      await page.screenshot({ path: file });
      taken.push(path.relative(ROOT, file));
      await page.close();
    }
  } finally {
    await browser.close().catch(() => {});
    for (const pid of playwrightChromePids()) {
      if (!before.has(pid)) await killTree(pid, { graceMs: 1500 }).catch(() => {});
    }
  }
  console.log(`screenshots: ${taken.join(", ") || "none"}`);
  return taken;
}

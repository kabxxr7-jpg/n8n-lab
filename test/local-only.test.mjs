// What the n8n process tree is actually doing on the network, sampled while the suite is running:
// it must listen only on the two lab ports and talk only to loopback addresses
// (telemetry, update checks and templates are switched off). This is a sample, not a proof of
// "never": it shows the state at the moment of the check.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { descendants } from "../scripts/lib/proc.mjs";
import { hook, lab, uniq } from "./helpers/lab.mjs";

function lsofAvailable() {
  try {
    execFileSync("lsof", ["-v"], { stdio: "ignore" });
    return true;
  } catch (e) {
    return e.status !== undefined && e.code !== "ENOENT";
  }
}

describe.skipIf(!lsofAvailable())("network footprint of n8n", () => {
  it("listens on 5690 and 4749 only and only talks to loopback", async () => {
    // some traffic first, so there are established connections to look at
    await hook("events", { event_id: uniq("net"), type: "net.check", data: {} });
    const pids = [lab().n8nPid, ...descendants(lab().n8nPid)];
    let out = "";
    try {
      out = execFileSync("lsof", ["-nP", "-a", "-p", pids.join(","), "-i"], { encoding: "utf8" });
    } catch (e) {
      out = e.stdout?.toString() ?? ""; // lsof exits 1 when it lists nothing
    }
    const rows = out.split("\n").slice(1).filter(Boolean);
    expect(rows.length).toBeGreaterThan(0);
    const listening = new Set();
    const nonLoopback = [];
    for (const row of rows) {
      const name = row.match(/(\S+)(?:\s+\(\w+\))?$/)?.[1] ?? "";
      const endpoints = name.split("->");
      if (/\(LISTEN\)/.test(row)) listening.add(endpoints[0].replace(/^.*:/, ""));
      for (const ep of endpoints) {
        if (!/^(127\.0\.0\.1|\[::1\]|localhost)/.test(ep) && !ep.startsWith("*:")) nonLoopback.push(ep);
      }
      if (row.includes("*:") && /\(LISTEN\)/.test(row)) nonLoopback.push(`wildcard listener: ${name}`);
    }
    expect(nonLoopback).toEqual([]);
    expect([...listening].sort()).toEqual(["4749", "5690"]);
  });
});

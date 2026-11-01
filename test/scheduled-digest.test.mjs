// Workflow 4 against a real n8n: a Schedule Trigger workflow that reads leads from
// the mock table (all pages), builds a digest and mails it, or sends nothing.
// Runs are started through n8n's own "execute workflow" call (not by waiting for 08:00);
// one test additionally lets the real scheduler fire a per-second copy.
import { beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "../scripts/lib/proc.mjs";
import { client, getExecution, lab, listExecutions, mock, nodeItems, ranNodes, saveEvidence, sleep, workflowId } from "./helpers/lab.mjs";

const FILE = "scheduled-digest.json";
const wf = () => workflowId(FILE);
const HOUR = 3600 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const tables = () => mock("tables");
const outbox = () => mock("outbox");
const leadFetches = () => tables().requests((r) => r.method === "GET" && r.path === "/tables/leads/rows");

async function resetWorld() {
  await tables().reset();
  await outbox().reset();
  await mock("alerts").clearFaults();
}

async function seedLead(row) {
  const res = await tables().send("POST", "/tables/leads/rows", row);
  expect(res.status).toBe(201);
  return res.json;
}

async function runDigestNow() {
  const c = client();
  await c.login(lab());
  const res = await c.runFromTrigger(wf(), "Schedule Trigger");
  expect(res.status).toBe(200);
  const id = res.body.data?.executionId ?? res.body.executionId;
  expect(id).toBeTruthy();
  let exec;
  await waitFor(
    async () => {
      exec = await getExecution(id);
      return ["success", "error", "crashed", "canceled"].includes(exec.status);
    },
    { timeoutMs: 30_000, what: `execution ${id} to finish` },
  );
  return exec;
}

describe("scheduled digest: what is stored in n8n", () => {
  it("is active, runs at 08:00 in Asia/Kolkata, and is linked to the error workflow", async () => {
    const stored = (await client().api(`/workflows/${wf()}`)).body;
    expect(stored.active).toBe(true);
    expect(stored.settings.timezone).toBe("Asia/Kolkata");
    expect(stored.settings.errorWorkflow).toBe(lab().errorHandlerId);
    const trigger = stored.nodes.find((n) => n.name === "Schedule Trigger");
    expect(trigger.type).toBe("n8n-nodes-base.scheduleTrigger");
    expect(trigger.parameters.rule.interval).toEqual([{ field: "cronExpression", expression: "0 8 * * *" }]);
  });
});

describe("scheduled digest: runs started through n8n", () => {
  beforeAll(resetWorld);

  it("empty day: reads the table, builds a digest of nothing and sends nothing", async () => {
    await resetWorld();
    const before = Date.now();
    const exec = await runDigestNow();
    expect(exec.status).toBe("success");
    expect(exec.mode).toBe("manual");
    const ran = ranNodes(exec);
    expect(ran).toEqual(
      expect.arrayContaining(["Schedule Trigger", "Compute window", "Fetch leads (all pages)", "Build digest", "Anything to report?", "Empty day: send nothing"]),
    );
    expect(ran).not.toContain("Send digest");
    expect(nodeItems(exec, "Build digest")[0]).toMatchObject({ total: 0, pending: 0 });
    expect(await outbox().requests()).toHaveLength(0);

    const fetches = await leadFetches();
    expect(fetches).toHaveLength(1);
    const since = Date.parse(fetches[0].query.created_after);
    expect(Math.abs(since - (before - 24 * HOUR))).toBeLessThan(30_000); // a 24 hour window
    await saveEvidence("digest-empty-day", exec, { workflow: FILE });
  });

  it("only old leads in the table: still nothing to send", async () => {
    await resetWorld();
    for (let i = 0; i < 4; i++) {
      await seedLead({ name: `Old ${i}`, company: "Old Co", status: "pending", fit_score: 90, tier: "high", created_at: ago(3 * 24 * HOUR) });
    }
    await seedLead({ name: "Just outside", company: "Edge Co", status: "pending", fit_score: 80, tier: "high", created_at: ago(24 * HOUR + 10 * 60_000) });
    const exec = await runDigestNow();
    expect(exec.status).toBe("success");
    expect(ranNodes(exec)).toContain("Empty day: send nothing");
    expect(ranNodes(exec)).not.toContain("Send digest");
    expect(await outbox().requests()).toHaveLength(0);
  });

  it("a busy day: reads every page, counts correctly, mails one digest", async () => {
    await resetWorld();
    // 6 rows outside the window, 120 inside (one of them 23h50m old, inside by 10 minutes)
    for (let i = 0; i < 5; i++) {
      await seedLead({ name: `Old ${i}`, company: "Old Co", status: "pending", fit_score: 99, tier: "high", created_at: ago(2 * 24 * HOUR) });
    }
    await seedLead({ name: "Just outside", company: "Edge Co", status: "pending", fit_score: 99, tier: "high", created_at: ago(24 * HOUR + 10 * 60_000) });
    const ids = [];
    for (let i = 0; i < 120; i++) {
      const status = i < 60 ? "pending" : i < 100 ? "sent" : "send_failed";
      const row = await seedLead({
        name: `Lead ${i}`,
        company: `Co ${i}`,
        status,
        // the first five rows are the five best; everyone else is below 91
        fit_score: i < 5 ? 100 - i : 50 + (i % 40),
        tier: "medium",
        created_at: i === 119 ? ago(23 * HOUR + 50 * 60_000) : ago(i * 60_000 + 60_000),
      });
      ids.push(row.id);
    }

    const exec = await runDigestNow();
    expect(exec.status).toBe("success");

    // three pages of 50/50/20 were fetched
    const fetches = await leadFetches();
    expect(fetches.map((f) => f.query.page)).toEqual(["1", "2", "3"]);
    expect(fetches.every((f) => f.query.page_size === "50")).toBe(true);
    expect(nodeItems(exec, "Fetch leads (all pages)").map((p) => p.rows.length)).toEqual([50, 50, 20]);

    const digest = nodeItems(exec, "Build digest")[0];
    expect(digest).toMatchObject({ total: 120, pending: 60, by_status: { pending: 60, sent: 40, send_failed: 20 } });

    const mails = await outbox().requests();
    expect(mails).toHaveLength(1);
    const mail = mails[0].body;
    expect(mail.to).toBe("leads-digest@n8n-lab.test");
    expect(mail.subject).toMatch(/^Lead digest \d{4}-\d{2}-\d{2}: 120 new, 60 awaiting approval$/);
    expect(mail.body).toContain("Leads created in the last 24 hours: 120");
    expect(mail.body).toContain("By status: pending 60, send_failed 20, sent 40");
    expect(mail.body).toContain("Awaiting approval: 60");
    const top = mail.body.split("Top by fit score:\n")[1].split("\n");
    expect(top).toHaveLength(5);
    expect(top.map((l) => l.split(" | ")[0])).toEqual(ids.slice(0, 5).map((id) => `- ${id}`));
    expect(top[0]).toContain("fit 100");
    expect(mail.body).not.toContain("Old Co");
    expect(mail.body).not.toContain("Edge Co");

    expect(ranNodes(exec)).toContain("Send digest");
    expect(ranNodes(exec)).not.toContain("Empty day: send nothing");
    await saveEvidence("digest-sent", exec, { workflow: FILE });
  });

  it("table API failure: the run fails, nothing is mailed (manual runs do not trigger the Error Workflow)", async () => {
    await resetWorld();
    await seedLead({ name: "Lead", company: "Co", status: "pending", fit_score: 70, tier: "high" });
    const alertsBefore = (await mock("alerts").requests()).length;
    try {
      await tables().fault({ method: "GET", pathPrefix: "/tables/leads/rows", status: 500, times: 1 });
      const exec = await runDigestNow();
      expect(exec.status).toBe("error");
      expect(ranNodes(exec)).not.toContain("Send digest");
      expect(exec.data.resultData.error.message).toMatch(/not able to process your request/i);
      expect(exec.data.resultData.lastNodeExecuted).toBe("Fetch leads (all pages)");
    } finally {
      await tables().clearFaults();
    }
    expect(await outbox().requests()).toHaveLength(0);
    await sleep(1500);
    expect((await mock("alerts").requests()).length).toBe(alertsBefore); // n8n only runs error workflows for automatic runs
  });
});

describe("scheduled digest: the real scheduler", () => {
  it("fires a per-second copy of the workflow: a failed run alerts, a later run mails, deactivating stops it", async () => {
    await resetWorld();
    const c = client();
    const original = (await c.api(`/workflows/${wf()}`)).body;
    const copy = {
      name: "Scheduled lead digest (per-second copy for the scheduler test)",
      nodes: original.nodes.map((n) =>
        n.name === "Schedule Trigger"
          ? { ...n, parameters: { rule: { interval: [{ field: "cronExpression", expression: "* * * * * *" }] } } }
          : n,
      ),
      connections: original.connections,
      settings: { ...original.settings },
    };
    for (let i = 0; i < 3; i++) {
      await seedLead({ name: `Lead ${i}`, company: `Co ${i}`, status: "pending", fit_score: 60 + i, tier: "medium" });
    }
    const created = await c.api("/workflows", { method: "POST", body: copy });
    expect(created.status).toBe(200);
    const id = created.body.id;
    try {
      await tables().fault({ method: "GET", pathPrefix: "/tables/leads/rows", status: 500, times: 1 });
      const act = await c.api(`/workflows/${id}/activate`, { method: "POST", body: {} });
      expect(act.body.active).toBe(true);

      let execs = [];
      await waitFor(
        async () => {
          execs = await listExecutions(id, { limit: 50 });
          return execs.some((e) => e.status === "error") && execs.some((e) => e.status === "success") && (await outbox().requests()).length >= 1;
        },
        { timeoutMs: 40_000, intervalMs: 500, what: "a failed and a successful scheduled run" },
      );
      await c.api(`/workflows/${id}/deactivate`, { method: "POST", body: {} });

      expect(execs.every((e) => e.mode === "trigger")).toBe(true); // fired by the scheduler, not by a person or the API
      const failed = execs.find((e) => e.status === "error");
      const good = execs.find((e) => e.status === "success");
      expect(ranNodes(good)).toContain("Send digest");
      expect(ranNodes(failed)).not.toContain("Send digest");

      await waitFor(async () => (await mock("alerts").requests((r) => r.body?.execution_id === String(failed.id))).length === 1, {
        timeoutMs: 15_000,
        what: "the alert for the failed scheduled run",
      });
      const alert = (await mock("alerts").requests((r) => r.body?.execution_id === String(failed.id)))[0];
      expect(alert.body).toMatchObject({ severity: "error", workflow: copy.name, failed_node: "Fetch leads (all pages)" });

      // after deactivation the schedule stops
      await sleep(1500);
      const settled = (await listExecutions(id, { limit: 100 })).length;
      await sleep(2500);
      expect((await listExecutions(id, { limit: 100 })).length).toBe(settled);
      await saveEvidence("digest-scheduler-fired-run", good, { workflow: copy.name });
    } finally {
      await tables().clearFaults();
      await c.api(`/workflows/${id}/deactivate`, { method: "POST", body: {} });
      await c.api(`/workflows/${id}`, { method: "DELETE" });
    }
  });
});

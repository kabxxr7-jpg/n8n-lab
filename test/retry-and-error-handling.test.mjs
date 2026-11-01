// Workflow 3 against a real n8n: dedupe by event id, retry-on-fail with a wait,
// timeouts, permanent failure -> Error Workflow -> alert.
import { describe, expect, it } from "vitest";
import { waitFor } from "../scripts/lib/proc.mjs";
import {
  client,
  executionsWhere,
  findExecution,
  hook,
  lab,
  mock,
  nodeItems,
  ranNodes,
  saveEvidence,
  sleep,
  uniq,
  workflowId,
} from "./helpers/lab.mjs";

const FILE = "retry-and-error-handling.json";
const WAIT_BETWEEN_TRIES_MS = 1000;
const TIMEOUT_MS = 1500;
const wf = () => workflowId(FILE);

const deliver = (id, data = { n: 1 }, type = "order.created") =>
  hook("events", { event_id: id, type, data }, { timeoutMs: 45_000 });
const attempts = (id) => mock("flaky").requests((r) => r.path === "/v1/process" && r.body?.event_id === id);
const claimOf = async (id) => (await mock("tables").table("event_claims")).find((r) => r.id === id);
const execFor = (id, n) =>
  findExecution(wf(), {
    trigger: "Webhook: event",
    match: (j) => j.body?.event_id === id && (n === undefined || j.body?.data?.n === n),
    timeoutMs: 30_000,
  });
const alertsFor = (id) => mock("alerts").requests((r) => r.body?.event_id === id);
const gaps = (reqs) => reqs.slice(1).map((r, i) => r.t - reqs[i].t);

describe("retry on fail", () => {
  it("processes a healthy event on the first try", async () => {
    const id = uniq("ok");
    const res = await deliver(id);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "processed", event_id: id });
    expect(await attempts(id)).toHaveLength(1);
    expect(await claimOf(id)).toMatchObject({ id, status: "done", type: "order.created" });
    const exec = await execFor(id);
    expect(exec.status).toBe("success");
    expect(ranNodes(exec)).not.toContain("Release claim");
    expect(ranNodes(exec)).not.toContain("Fail execution");
    expect(await alertsFor(id)).toHaveLength(0);
  });

  it("succeeds on the 3rd try after two 500s, waiting between tries", async () => {
    const id = uniq("r500");
    await mock("flaky").script(id, [500, 500, "ok"]);
    const res = await deliver(id);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "processed", event_id: id });

    const calls = await attempts(id);
    expect(calls.map((c) => c.attempt)).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.response.status)).toEqual([500, 500, 200]);
    for (const g of gaps(calls)) expect(g).toBeGreaterThanOrEqual(WAIT_BETWEEN_TRIES_MS - 100);
    expect(res.ms).toBeGreaterThanOrEqual(2 * WAIT_BETWEEN_TRIES_MS - 100);

    const exec = await execFor(id);
    expect(exec.status).toBe("success");
    const ran = ranNodes(exec);
    expect(ran).toEqual(expect.arrayContaining(["Call flaky API", "Mark claim done", "Respond 200 processed"]));
    expect(ran).not.toContain("Release claim");
    expect(ran).not.toContain("Fail execution");
    expect(nodeItems(exec, "Call flaky API", { output: 0 })[0]).toMatchObject({ ok: true, attempt: 3, result: "processed" });
    expect(nodeItems(exec, "Call flaky API", { output: 1 })).toHaveLength(0); // nothing on the error output
    expect(await claimOf(id)).toMatchObject({ status: "done" });
    expect(await alertsFor(id)).toHaveLength(0); // a retried success is not an incident
    await saveEvidence("retry-succeeds-on-third-try", exec, { workflow: FILE });
  });

  it("gives up on a hanging API after the request timeout and succeeds on the 3rd try", async () => {
    const id = uniq("rhang");
    await mock("flaky").script(id, ["hang", "hang", "ok"]);
    const res = await deliver(id);
    expect(res.status).toBe(200);

    const calls = await attempts(id);
    expect(calls).toHaveLength(3);
    expect(calls[0].client_aborted).toBe(true); // n8n hung up, the mock did not time out by itself
    expect(calls[1].client_aborted).toBe(true);
    expect(calls[2].response.status).toBe(200);
    for (const g of gaps(calls)) expect(g).toBeGreaterThanOrEqual(TIMEOUT_MS + WAIT_BETWEEN_TRIES_MS - 150);
    expect(res.ms).toBeGreaterThanOrEqual(2 * (TIMEOUT_MS + WAIT_BETWEEN_TRIES_MS) - 300);
    expect((await execFor(id)).status).toBe("success");
  });
});

describe("permanent failure and the Error Workflow", () => {
  it("after 3 failed tries: releases the claim, answers 502, fails the execution, and the Error Workflow records an alert", async () => {
    const id = uniq("perm");
    await mock("flaky").script(id, [500]);
    const res = await deliver(id);
    expect(res.status).toBe(502);
    expect(res.json).toEqual({ status: "failed", event_id: id });

    const calls = await attempts(id);
    expect(calls).toHaveLength(3); // exactly maxTries, not more
    expect(calls.every((c) => c.response.status === 500)).toBe(true);
    expect(await claimOf(id)).toBeUndefined(); // released so a redelivery can be processed

    const exec = await execFor(id);
    expect(exec.status).toBe("error");
    expect(ranNodes(exec)).toEqual(expect.arrayContaining(["Release claim", "Respond 502 failed", "Fail execution"]));
    expect(ranNodes(exec)).not.toContain("Mark claim done");
    expect(exec.data.resultData.error.message).toContain(`Event ${id} failed after retries`);
    expect(exec.data.resultData.lastNodeExecuted).toBe("Fail execution");

    await waitFor(async () => (await alertsFor(id)).length >= 1, { timeoutMs: 15_000, what: "the alert" });
    const alerts = await alertsFor(id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toMatchObject({
      severity: "error",
      workflow: "Retry, dedupe and error handling",
      execution_id: String(exec.id),
      failed_node: "Fail execution",
      event_id: id,
    });
    expect(alerts[0].body.message).toContain(`Event ${id} failed after retries`);

    // and the handler itself ran as an n8n error-mode execution
    const handlerExec = await findExecution(workflowId("error-handler.json"), {
      trigger: "Error Trigger",
      match: (j) => String(j.execution?.id) === String(exec.id),
    });
    expect(handlerExec.mode).toBe("error");
    expect(handlerExec.status).toBe("success");
    expect(ranNodes(handlerExec)).toEqual(["Error Trigger", "Format alert", "Post alert"]);
    await saveEvidence("retry-permanent-failure", exec, { workflow: FILE });
    await saveEvidence("error-handler-records-alert", handlerExec, { workflow: "error-handler.json" });
  });

  it("treats a permanently hanging API as a failure too (3 aborted tries, then the alert)", async () => {
    const id = uniq("permhang");
    await mock("flaky").script(id, ["hang"]);
    const res = await deliver(id);
    expect(res.status).toBe(502);
    const calls = await attempts(id);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.client_aborted === true)).toBe(true);
    await waitFor(async () => (await alertsFor(id)).length === 1, { timeoutMs: 15_000, what: "the alert" });
    expect((await execFor(id)).status).toBe("error");
  });

  it("processes a redelivery of a failed event once the API has recovered (failure is not remembered as 'seen')", async () => {
    const id = uniq("recover");
    await mock("flaky").script(id, [500, 500, 500, "ok"]);
    expect((await deliver(id, { n: 1 })).status).toBe(502);
    const second = await deliver(id, { n: 2 });
    expect(second.status).toBe(200);
    expect(second.json).toEqual({ status: "processed", event_id: id });
    expect(await attempts(id)).toHaveLength(4);
    expect(await claimOf(id)).toMatchObject({ status: "done" });
    await waitFor(async () => (await alertsFor(id)).length >= 1, { timeoutMs: 15_000, what: "the alert" });
    await sleep(1000);
    expect(await alertsFor(id)).toHaveLength(1); // only the first, failed, delivery alerted
  });
});

describe("dedupe", () => {
  it("a second delivery of the same event id is not processed again", async () => {
    const id = uniq("dup");
    const first = await deliver(id, { n: 1 });
    expect(first.json).toEqual({ status: "processed", event_id: id });
    const second = await deliver(id, { n: 2 });
    expect(second.status).toBe(200);
    expect(second.json).toEqual({ status: "duplicate", event_id: id });
    expect(await attempts(id)).toHaveLength(1);
    expect((await mock("tables").table("event_claims")).filter((r) => r.id === id)).toHaveLength(1);

    const exec = await execFor(id, 2);
    expect(exec.status).toBe("success");
    expect(ranNodes(exec)).toContain("Respond duplicate");
    expect(ranNodes(exec)).not.toContain("Call flaky API");
    expect(nodeItems(exec, "Claim event id")[0].statusCode).toBe(409);
    await saveEvidence("dedupe-duplicate-skipped", exec, { workflow: FILE });
  });

  it("six simultaneous deliveries of one event id call the API exactly once", async () => {
    const id = uniq("par");
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => deliver(id, { n: i + 1 })));
    const processed = results.filter((r) => r.json.status === "processed");
    expect(processed).toHaveLength(1);
    for (const r of results.filter((x) => x !== processed[0])) {
      expect(["duplicate", "in_progress"]).toContain(r.json.status);
    }
    expect(await attempts(id)).toHaveLength(1);
  });

  it("a duplicate that arrives while the first delivery is still retrying gets 409 in_progress, then 200 duplicate once it is done", async () => {
    const id = uniq("inflight");
    await mock("flaky").script(id, ["hang", "ok"]); // first delivery takes ~2.5 s
    const firstP = deliver(id, { n: 1 });
    await sleep(500);
    const early = await deliver(id, { n: 2 });
    expect(early.status).toBe(409);
    expect(early.json).toEqual({ status: "in_progress", event_id: id });
    const first = await firstP;
    expect(first.status).toBe(200);
    const late = await deliver(id, { n: 3 });
    expect(late.status).toBe(200);
    expect(late.json.status).toBe("duplicate");
    expect(await attempts(id)).toHaveLength(2); // hang + ok, both from the first delivery
  });

  it("different event ids are processed independently", async () => {
    const [a, b] = [uniq("ia"), uniq("ib")];
    const [ra, rb] = await Promise.all([deliver(a), deliver(b)]);
    expect([ra.json.status, rb.json.status]).toEqual(["processed", "processed"]);
    expect(await attempts(a)).toHaveLength(1);
    expect(await attempts(b)).toHaveLength(1);
  });

  it("answers 503 and calls nothing when the claim store is down", async () => {
    const tables = mock("tables");
    const id = uniq("claimdown");
    try {
      await tables.fault({ method: "POST", pathPrefix: "/tables/event_claims", status: 500, times: 1 });
      const res = await deliver(id);
      expect(res.status).toBe(503);
      expect(res.json).toEqual({ error: "claim_store_unavailable" });
    } finally {
      await tables.clearFaults();
    }
    expect(await attempts(id)).toHaveLength(0);
    expect(await claimOf(id)).toBeUndefined();
  });

  it.each([
    ["no event id", { type: "x", data: {} }],
    ["an event id with spaces", { event_id: "a b", type: "x", data: {} }],
    ["no type", { event_id: "abc", data: {} }],
    ["data that is not an object", { event_id: "abc", type: "x", data: [1] }],
  ])("rejects %s with 400 and claims nothing", async (_label, body) => {
    const claimsBefore = (await mock("tables").table("event_claims")).length;
    const callsBefore = (await mock("flaky").requests()).length;
    const res = await hook("events", body);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("invalid_event");
    expect((await mock("tables").table("event_claims")).length).toBe(claimsBefore);
    expect((await mock("flaky").requests()).length).toBe(callsBefore);
  });
});

describe("error workflow wiring", () => {
  it("is linked in the workflow settings that n8n stored, and points at the handler workflow", async () => {
    const stored = (await client().api(`/workflows/${wf()}`)).body;
    expect(stored.settings.errorWorkflow).toBe(lab().errorHandlerId);
    const handler = (await client().api(`/workflows/${lab().errorHandlerId}`)).body;
    expect(handler.name).toBe("Error handler: record failure to alerts");
    const node = stored.nodes.find((n) => n.name === "Call flaky API");
    expect(node).toMatchObject({ retryOnFail: true, maxTries: 3, waitBetweenTries: WAIT_BETWEEN_TRIES_MS });
    expect(node.parameters.options.timeout).toBe(TIMEOUT_MS);
  });

  it("alerts and failed executions match one to one (retried successes and duplicates raise nothing)", async () => {
    const name = "Retry, dedupe and error handling";
    const failed = await executionsWhere(wf(), (e) => e.status === "error");
    expect(failed.length).toBeGreaterThanOrEqual(3);
    await waitFor(
      async () => {
        const alerts = (await mock("alerts").requests()).filter((a) => a.body?.workflow === name);
        return alerts.length === failed.length;
      },
      { timeoutMs: 15_000, what: "one alert per failed execution" },
    );
    const alerts = (await mock("alerts").requests()).filter((a) => a.body?.workflow === name);
    expect(new Set(alerts.map((a) => a.body.execution_id))).toEqual(new Set(failed.map((e) => String(e.id))));
  });
});

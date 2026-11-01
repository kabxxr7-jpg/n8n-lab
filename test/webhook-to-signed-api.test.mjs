// Workflow 2 against a real n8n: validate, 202, HMAC-signed call to a mock API,
// confidence branch (auto / review queue), callback to the caller's URL.
import { describe, expect, it } from "vitest";
import { sign } from "../mocks/services.mjs";
import { waitFor } from "../scripts/lib/proc.mjs";
import { findExecution, hook, lab, mock, nodeItems, ranNodes, saveEvidence, uniq, workflowId } from "./helpers/lab.mjs";

const FILE = "webhook-to-signed-api.json";
const CALLBACK = "http://127.0.0.1:4704/callback";
const wf = () => workflowId(FILE);

const send = (event) => hook("signed-intake", event);
const callbacksFor = (id) => mock("callback").requests((r) => r.body?.event_id === id);
const signedCallsFor = (id) => mock("signed").requests((r) => r.body?.event_id === id);
const reviewRows = async (id) => (await mock("tables").table("review_queue")).filter((r) => r.event_id === id);
const execFor = (id) => findExecution(wf(), { trigger: "Webhook: event", match: (j) => j.body?.event_id === id });

async function deliver(text, { id = uniq("evt"), expectCallbacks = 1 } = {}) {
  const res = await send({ event_id: id, text, callback_url: CALLBACK });
  await waitFor(async () => (await callbacksFor(id)).length >= expectCallbacks, {
    timeoutMs: 15_000,
    what: `${expectCallbacks} callback(s) for ${id}`,
  });
  return { id, res, callbacks: await callbacksFor(id) };
}

describe("webhook to signed API: the signed call", () => {
  it("signs the exact bytes it sends and the API accepts the signature", async () => {
    const text = 'He said "refund" \\ café 日本 line\nbreak';
    const { id, res } = await deliver(text);
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ accepted: true, event_id: id });

    const calls = await signedCallsFor(id);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.verification).toEqual({ valid: true, reason: "ok" });
    expect(call.response.status).toBe(200);

    // recompute the signature here, with the secret the harness gave n8n
    const ts = call.headers["x-lab-timestamp"];
    expect(call.headers["x-lab-signature"]).toBe(sign(lab().signingSecret, ts, call.raw));
    expect(call.headers["x-lab-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(Math.abs(Date.now() / 1000 - Number(ts))).toBeLessThan(60);
    expect(call.raw).toBe(JSON.stringify({ event_id: id, text }));
    expect(call.headers["content-type"]).toContain("application/json");
  });

  it("the mock API really rejects a bad, stale or missing signature (so 'valid' above means something)", async () => {
    const signed = mock("signed");
    const body = JSON.stringify({ event_id: "e1", text: "refund" });
    const now = String(Math.floor(Date.now() / 1000));
    const post = (headers) =>
      fetch(`${signed.url}/v1/classify`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
    const secret = lab().signingSecret;

    expect((await post({ "x-lab-timestamp": now, "x-lab-signature": sign(secret, now, body) })).status).toBe(200);
    expect((await post({ "x-lab-timestamp": now, "x-lab-signature": sign("wrong-secret", now, body) })).status).toBe(401);
    expect((await post({ "x-lab-timestamp": now, "x-lab-signature": sign(secret, now, body + " ") })).status).toBe(401);
    const old = String(Math.floor(Date.now() / 1000) - 1000);
    expect((await post({ "x-lab-timestamp": old, "x-lab-signature": sign(secret, old, body) })).status).toBe(401);
    expect((await post({})).status).toBe(401);
  });
});

describe("webhook to signed API: confidence branch", () => {
  it("high confidence goes straight to the callback and never touches the review queue", async () => {
    const { id, res, callbacks } = await deliver("Please refund my last order, it arrived broken");
    expect(res.status).toBe(202);
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0].path).toBe("/callback");
    expect(callbacks[0].body).toEqual({ event_id: id, status: "auto_processed", label: "refund_request", confidence: 0.95 });
    expect(await reviewRows(id)).toHaveLength(0);

    const exec = await execFor(id);
    expect(exec.status).toBe("success");
    const ran = ranNodes(exec);
    expect(ran).toEqual(
      expect.arrayContaining([
        "Webhook: event",
        "Validate event",
        "Respond 202 accepted",
        "Sign request",
        "Call signed API",
        "Confident?",
        "Callback: auto processed",
      ]),
    );
    for (const n of ["Add to review queue", "Callback: needs review", "Callback: failed", "Respond 400 invalid event"]) {
      expect(ran).not.toContain(n);
    }
    expect(nodeItems(exec, "Confident?", { output: 0 })).toHaveLength(1); // item left through the "true" output
    expect(nodeItems(exec, "Confident?", { output: 1 })).toHaveLength(0);
    await saveEvidence("signed-api-high-confidence", exec, { workflow: FILE });
  });

  it("low confidence goes to the review queue, then the callback says needs_review", async () => {
    const text = "hello, I have a question about something";
    const { id, callbacks } = await deliver(text);
    const rows = await reviewRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_id: id, label: "other", confidence: 0.42, text, reason: "low_confidence", status: "open" });
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0].body).toEqual({
      event_id: id,
      status: "needs_review",
      review_id: rows[0].id,
      label: "other",
      confidence: 0.42,
    });

    const exec = await execFor(id);
    expect(exec.status).toBe("success");
    const ran = ranNodes(exec);
    expect(ran).toEqual(expect.arrayContaining(["Confident?", "Add to review queue", "Callback: needs review"]));
    expect(ran).not.toContain("Callback: auto processed");
    expect(nodeItems(exec, "Confident?", { output: 0 })).toHaveLength(0);
    expect(nodeItems(exec, "Confident?", { output: 1 })).toHaveLength(1);
    await saveEvidence("signed-api-low-confidence", exec, { workflow: FILE });
  });

  it.each([
    ["billing, 0.88", "question about my invoice", "auto_processed", 0.88],
    ["account access, 0.84", "I cannot reset my password", "auto_processed", 0.84],
    ["exactly on the 0.8 threshold", "threshold-exact case", "auto_processed", 0.8],
    ["just below the threshold, 0.79", "threshold-below case", "needs_review", 0.79],
    ["unsure, 0.55", "maybe this is about shipping", "needs_review", 0.55],
  ])("routes %s", async (_label, text, status, confidence) => {
    const { id, callbacks } = await deliver(text);
    expect(callbacks[0].body).toMatchObject({ status, confidence });
    expect((await reviewRows(id)).length).toBe(status === "needs_review" ? 1 : 0);
  });
});

describe("webhook to signed API: failures and bad input", () => {
  it.each([
    ["rejects the signature (401)", 401],
    ["fails (500)", 500],
  ])("when the signed API %s, the caller gets a 'failed' callback and nothing is queued", async (_label, status) => {
    const signed = mock("signed");
    const id = uniq("evt");
    try {
      await signed.fault({ method: "POST", pathPrefix: "/v1/classify", status, times: 1 });
      const { callbacks } = await deliver("please refund me", { id });
      expect(callbacks[0].body).toEqual({ event_id: id, status: "failed", reason: "classifier_error" });
    } finally {
      await signed.clearFaults();
    }
    expect(await reviewRows(id)).toHaveLength(0);
    const exec = await execFor(id);
    expect(exec.status).toBe("success"); // handled failure
    expect(ranNodes(exec)).toContain("Callback: failed");
    expect(ranNodes(exec)).not.toContain("Callback: auto processed");
  });

  it.each([
    ["no event id", { text: "refund", callback_url: CALLBACK }, "event_id must be"],
    ["an event id with a slash", { event_id: "a/b", text: "refund", callback_url: CALLBACK }, "event_id must be"],
    ["empty text", { event_id: "ok1", text: "   ", callback_url: CALLBACK }, "text must be"],
    ["text over 2000 characters", { event_id: "ok2", text: "x".repeat(2001), callback_url: CALLBACK }, "text must be"],
    ["a callback URL on another host", { event_id: "ok3", text: "refund", callback_url: "http://evil.test/cb" }, "callback_url must start with"],
    ["a user-info trick in the callback URL", { event_id: "ok4", text: "refund", callback_url: "http://127.0.0.1:4704@evil.test/cb" }, "callback_url must start with"],
    ["an https callback URL", { event_id: "ok5", text: "refund", callback_url: "https://127.0.0.1:4704/cb" }, "callback_url must start with"],
    ["no callback URL", { event_id: "ok6", text: "refund" }, "callback_url must start with"],
  ])("answers 400 for %s and calls nothing downstream", async (_label, body, fragment) => {
    const signedBefore = (await mock("signed").requests()).length;
    const cbBefore = (await mock("callback").requests()).length;
    const res = await send({ ...body, event_id: body.event_id === undefined ? undefined : `${body.event_id}-${uniq("x")}`.slice(0, 64) });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("invalid_event");
    expect(res.json.details.join(" ")).toContain(fragment);
    await new Promise((r) => setTimeout(r, 400));
    expect((await mock("signed").requests()).length).toBe(signedBefore);
    expect((await mock("callback").requests()).length).toBe(cbBefore);
  });

  it("accepts text of exactly 2000 characters", async () => {
    const { callbacks } = await deliver("refund " + "x".repeat(1993));
    expect(callbacks[0].body.status).toBe("auto_processed");
  });
});

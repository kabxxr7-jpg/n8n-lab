// Tiny HTTP mock-service toolkit. Every mock records each request it receives
// (method, path, query, headers, raw body, parsed body, response) so tests can
// assert on exactly what the outside world would have seen.
//
// Built-in control endpoints on every mock (never recorded as requests):
//   GET  /__requests   -> { requests: [...] }
//   POST /__reset      -> clears the request log, faults and the mock's own state
//   POST /__fault      -> { method?, pathPrefix, status, times, body? } make the next
//                         `times` matching requests fail with `status`; { clear: true } removes all
//   GET  /__health     -> { ok: true, name }
// A mock can add its own /__* control routes through the `control` option.
import http from "node:http";

export const HOST = "127.0.0.1";

export function sendJson(res, status, body, headers = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * @param {object} opts
 * @param {string} opts.name
 * @param {number} opts.port
 * @param {(ctx: object) => Promise<{status:number, body?:any, headers?:object}|void>} opts.handler
 *        ctx = { req, res, url, body, raw, rec, state }. Return a response object, or
 *        write to ctx.res yourself and return undefined (set rec.response manually).
 * @param {() => object} [opts.initialState]
 * @param {(ctx: object) => Promise<{status:number, body?:any}|undefined>} [opts.control]
 *        extra /__* control routes: ctx = { req, url, body, state }
 */
export function createMock({ name, port, handler, initialState = () => ({}), control }) {
  let requests = [];
  let faults = [];
  let state = initialState();
  let seq = 0;
  const open = new Set();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${port}`);
    try {
      if (url.pathname.startsWith("/__")) {
        if (url.pathname === "/__health") return sendJson(res, 200, { ok: true, name });
        if (url.pathname === "/__requests" && req.method === "GET") {
          return sendJson(res, 200, { requests });
        }
        if (url.pathname === "/__reset" && req.method === "POST") {
          requests = [];
          faults = [];
          state = initialState();
          seq = 0;
          return sendJson(res, 200, { ok: true });
        }
        if (url.pathname === "/__fault" && req.method === "POST") {
          const f = JSON.parse((await readBody(req)) || "{}");
          if (f.clear) {
            faults = [];
            return sendJson(res, 200, { ok: true, faults: 0 });
          }
          faults.push({ times: 1, status: 500, ...f });
          return sendJson(res, 200, { ok: true, faults: faults.length });
        }
        if (control) {
          const raw = await readBody(req);
          let body;
          try {
            body = raw ? JSON.parse(raw) : undefined;
          } catch {
            return sendJson(res, 400, { error: "invalid_json" });
          }
          const out = await control({ req, url, body, state });
          if (out) return sendJson(res, out.status, out.body);
        }
        return sendJson(res, 404, { error: "unknown control endpoint" });
      }

      const raw = await readBody(req);
      let body;
      let bodyParseError = false;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          bodyParseError = true;
        }
      }
      const rec = {
        seq: ++seq,
        at: new Date().toISOString(),
        t: Date.now(),
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        raw,
        body,
        bodyParseError,
        response: null,
      };
      requests.push(rec);

      const fault = faults.find(
        (f) =>
          f.times > 0 &&
          (!f.method || f.method === req.method) &&
          url.pathname.startsWith(f.pathPrefix || "/"),
      );
      if (fault) {
        fault.times -= 1;
        rec.response = { status: fault.status, fault: true };
        return sendJson(res, fault.status, fault.body ?? { error: "injected_fault" });
      }

      const out = await handler({ req, res, url, body, raw, rec, state, requests });
      if (out) {
        rec.response = { status: out.status, body: out.body, ...(out.note ? { note: out.note } : {}) };
        if (!res.writableEnded) sendJson(res, out.status, out.body, out.headers);
      }
    } catch (err) {
      if (!res.writableEnded) sendJson(res, 500, { error: "mock_crashed", message: String(err) });
    }
  });

  server.on("connection", (sock) => {
    open.add(sock);
    sock.on("close", () => open.delete(sock));
  });

  return {
    name,
    port,
    start() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, HOST, () => resolve());
      });
    },
    stop() {
      return new Promise((resolve) => {
        for (const s of open) s.destroy();
        server.close(() => resolve());
      });
    },
  };
}

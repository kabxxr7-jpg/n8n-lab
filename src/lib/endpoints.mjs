// Where the workflows send their requests. Swapping a mock for a real service
// means changing one of these base URLs (and adding the service's credentials).
import { PORTS } from "../../mocks/services.mjs";

const base = (port) => `http://127.0.0.1:${port}`;
export const URLS = {
  tables: base(PORTS.tables),
  email: base(PORTS.email),
  llm: base(PORTS.llm),
  signed: base(PORTS.signed),
  callbackPrefix: `${base(PORTS.callback)}/`,
  flaky: base(PORTS.flaky),
  alerts: base(PORTS.alerts),
  outbox: base(PORTS.outbox),
};

// Fixed ids so the error workflow can be linked from the others in the exported
// JSON (n8n's CLI import keeps ids; the harness re-maps them when it uses the API).
export const ERROR_WORKFLOW_ID = "labErrorHandler01";

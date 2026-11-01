# n8n-lab

> **Status:** ran on 2026-11-01, macOS 27.2 (Darwin, arm64), n8n **2.45.7** (npm package, self-hosted, regular mode, SQLite) on Node **v26.13.0**.
> 98 tests in 5 files pass against a real n8n instance, 46 to 49 recorded n8n executions are asserted on (the count varies with how often the real-scheduler test's copy fires), and the mutation check kills **49 of 49** mutants. A full test run takes about 55 seconds on a quiet machine, including starting the mocks and n8n and, on a first run, creating the n8n database (measured in a fresh clone: `npm ci` 51 s, `npm test` 55 s). The same suite took 21 minutes once while the machine was overloaded by other work, so timings here are for an idle machine. The mutation check takes about 36 minutes.
> The CI file `.github/workflows/ci.yml` **has not run** (this repository has no remote yet). Each of its steps was run by hand in a fresh clone on macOS with Node 26 (the install variant `npm ci --ignore-scripts && npm rebuild sqlite3`, `check:workflows`, `npm test`, the quick self-test). **Node 24 (what the CI file pins), Linux and the workflow file itself are untested.**

Honest proof for freelance workflow-automation jobs (n8n, and by extension the same patterns in Make or Zapier). The sibling kits test code. This one tests **workflows that run for real**: a real n8n server, real webhooks, real executions, with the outside world replaced by eight small local mock services. The tests fire HTTP requests at the workflow webhooks and then check three things: the HTTP answer, what n8n recorded for that execution (status, which nodes ran, what each node output), and what the mock services actually received.

The job it is built to answer: **"connect and fix an existing lead workflow: leads in, AI fit check, draft, human approval, send only approved."**

No n8n Cloud, no account anywhere, no real third-party service. See [Limits](#limits-and-what-this-does-not-prove).

## What is in here

| # | Workflow (exported JSON) | What it does | Test file |
|---|---|---|---|
| 1 | `workflows/lead-approval-gate.json` and `workflows/lead-approval-gate-llm.json` | Webhook receives a lead, validates it, scores it (a deterministic Code node, or the variant that calls a mock "LLM" HTTP service and falls back to the rules when the answer is bad), writes lead + draft to the mock table as `pending`. **Only** the second webhook `approve` sends, once. | `test/lead-approval-gate.test.mjs` |
| 2 | `workflows/webhook-to-signed-api.json` | Webhook, validation, answers 202, calls a mock API with an HMAC-SHA256 signature header, confidence branch (high goes on, low goes to a review queue), callback to the caller's URL. | `test/webhook-to-signed-api.test.mjs` |
| 3 | `workflows/retry-and-error-handling.json` + `workflows/error-handler.json` | HTTP node that fails with 500 or hangs a scripted number of times: retry-on-fail succeeds on the 3rd try, a permanent failure fails the execution and the Error Workflow posts an alert. Duplicate deliveries of one event id are processed once. | `test/retry-and-error-handling.test.mjs` |
| 4 | `workflows/scheduled-digest.json` | Schedule Trigger (08:00 Asia/Kolkata) reads the last 24 h of leads from the mock table (all pages), builds a digest, mails it to a mock outbox. An empty day sends nothing. | `test/scheduled-digest.test.mjs` |

Also: `test/local-only.test.mjs` (the n8n process tree only uses loopback and the two lab ports), `scripts/mutation-check.mjs` (49 mutants), `evidence/` (real execution exports, screenshots, mutation report).

## Run it

Needs Node 24 or newer (n8n 2.45.7 declares `>=24`) and about 4.5 GB of disk for n8n's dependency tree. macOS arm64 was used; nothing in the scripts is macOS-only except the screenshot step, which uses the locally installed Google Chrome.

```bash
npm ci                    # installs n8n 2.45.7 into ./node_modules (git-ignored)
npm test                  # starts mocks + a real n8n, imports the workflows, runs everything
npm run mutation          # all 49 mutants against real n8n, one at a time (about 36 minutes here; 21 of them are the mutants themselves)
npm run mutation:selftest # plants a hang and proves the whole process tree gets killed
npm run evidence          # test run that also saves sanitised execution exports and editor screenshots
npm run n8n:start         # just run it: editor on http://127.0.0.1:5690, workflows loaded and active
npm run verify:cli-import # the JSON in workflows/ imports with n8n's own CLI into an empty n8n
npm run hygiene           # scans tracked files and commit messages for names, keys, home paths
```

The first `npm test` creates `.n8n-data/` (git-ignored): n8n's database, a local owner account with a **generated throwaway password** and an API key, both kept only in `.n8n-data/lab-secrets.json`. They are never printed and never committed. The owner account exists on `127.0.0.1` only; no account is created anywhere else.

### Setup facts

| | |
|---|---|
| n8n | exactly **2.45.7** (`package.json` pins it without a range; `package-lock.json` pins the tree) |
| Telemetry | off: `N8N_DIAGNOSTICS_ENABLED`, `N8N_VERSION_NOTIFICATIONS_ENABLED`, `N8N_TEMPLATES_ENABLED`, `N8N_PERSONALIZATION_ENABLED`, `N8N_HIRING_BANNER_ENABLED`, `N8N_DYNAMIC_BANNERS_ENABLED`, `N8N_AI_ENABLED`, `N8N_COMMUNITY_PACKAGES_ENABLED`, `N8N_LICENSE_AUTO_RENEW_ENABLED` all `false` (see `scripts/lib/stack.mjs`) |
| Data folder | `N8N_USER_FOLDER=./.n8n-data` (git-ignored) |
| Ports | n8n on **5690**. n8n's internal task-runner broker (it runs Code nodes) is moved from its default to **4749**. Mocks on **4700-4707**. Nothing else is opened. |
| Node | n8n runs on the **system Node** (v26.13.0 here). n8n 2.45.7 did not refuse to start on it, so the pinned-Node fallback described in the task (a Node 22 tarball in `.tools/`) was **not needed and not built**. `LAB_NODE=/path/to/node` overrides the binary. |
| npm | npm 11.20 skips dependency install scripts unless approved (`allowScripts` in `package.json`). Only `sqlite3` (n8n's database driver, needs its native binding) is approved; the other 14 packages that have install scripts (native add-ons, optional vendor drivers, `@scarf/scarf` install analytics and `agent-browser`, which downloads a binary from GitHub) are not run. The one approved script is that package's own installer, which fetches a prebuilt binding for your platform. With an older npm use `npm ci --ignore-scripts && npm rebuild sqlite3`. |
| Executions | all saved, never pruned; every harness start deletes old ones first |

## How the tests work

`test/global-setup.mjs` -> `scripts/lib/stack.mjs`:

1. start the eight mocks in-process (4700-4707);
2. start n8n (`n8n start`, own process group), wait for `/healthz/readiness`; on the first run create the owner and an API key;
3. upload the workflows from `workflows/` with n8n's **public REST API** (`/api/v1/workflows`), link the Error Workflow, activate them, and wait until each webhook path answers;
4. the tests send real HTTP requests to `http://127.0.0.1:5690/webhook/...`, then read executions back from `/api/v1/executions?includeData=true` and the mocks' request logs from `GET /__requests`;
5. stop n8n (its whole process tree) and the mocks.

Every mock records each request it gets (method, path, headers, raw body, the response it gave) and supports `POST /__fault` to make the next requests fail and `POST /__reset`. The flaky mock takes a script per event id, for example `[500, 500, "ok"]` or `["hang", "hang", "ok"]`.

`workflows/*.json` are **generated** from `src/workflows/*.mjs` (`npm run build:workflows`; `npm run check:workflows` fails if the committed JSON is stale). Code-node bodies live as plain JS in `src/code/`.

## 1. Lead approval gate

```
POST /webhook/lead-intake  --> validate --> score (rules | mock LLM) --> draft --> write row status=pending --> 201 {lead_id}
POST /webhook/lead-approve --> validate --> get lead --> CLAIM (PATCH if_status=pending|send_failed -> sending)
                                                        --> won? --> send email --> mark sent --> 200
                                                        --> lost --> 409 already_processed
                                          unknown id --> 404 lead_not_found
```

- **Scoring (rules)**: company size, senior title, budget, keywords in the message, free-mail penalty; 0-100, tiers high >= 70, medium >= 40. Three fixture leads land on 95 / 60 / 0. It is arithmetic, not a model.
- **LLM variant**: calls a local chat-completions-shaped mock (`/v1/chat/completions`). The answer is parsed and validated (JSON, score 0-100, non-empty draft); if the service is down (503), answers with text, or returns a score of 250, the lead is scored by the rules and stored with `scored_by: rules-fallback` and the reason. The mock is deterministic arithmetic with different weights from the rules, so tests can tell the two apart. **No real model is involved.**
- **Send exactly once**: the claim is an atomic compare-and-set on the table row (`if_status`). Six simultaneous approvals of one lead produce one 200, five 409 and one email. A failed send leaves `send_failed` and allows a retry; it never says `sent`.
- **What the tests check** (54 tests, run once per variant plus LLM-only cases): fixture scores; 7 invalid-lead shapes return 400 and store nothing; a prompt-injection style message does not send anything; approval sends the stored draft with an idempotency key; double and parallel approval; unknown and malformed ids return clear errors without touching the table or the sender; only the approved lead of three is sent; email provider failure; table API down at intake and at approval. Most also check which nodes ran in the recorded execution.

## 2. Webhook to signed API with a confidence branch

- The request body is serialised once, signed as `HMAC-SHA256(secret, "<unix seconds>.<body>")` in a Code node, and sent as the raw body so the bytes match. Headers `X-Lab-Timestamp` and `X-Lab-Signature: sha256=<hex>`. The mock API verifies the signature and a 5 minute window and records the verdict.
- The test recomputes the signature itself from the mock's recorded raw body and the secret, and also calls the mock directly with a wrong, tampered, stale and missing signature to show the mock really rejects them.
- Confidence >= 0.8 goes straight to the callback; below goes to the `review_queue` table, then the callback says `needs_review`. Fixtures sit exactly on 0.80 and 0.79 to pin the boundary.
- The callback URL must start with `http://127.0.0.1:4704/` (allow-list; a user-info trick and an https URL are rejected). A rejected or failed signature call produces a `failed` callback.

## 3. Retry, dedupe and the Error Workflow

- `Call flaky API`: **retry on fail, 3 tries, 1000 ms between tries, 1500 ms request timeout.** Tests prove the 3rd try succeeds after two 500s and after two hangs (the mock records that **n8n hung up**, so the timeout setting is observed, not assumed) and measure the gaps between attempts.
- n8n's built-in retry waits a **fixed** time between tries; it has no exponential backoff. That is what is configured and tested.
- A permanent failure (3 failed tries): the claim is released, the caller gets 502, a `Stop and Error` node fails the execution (status `error` in n8n), and the linked **Error Workflow** records an alert at the mock endpoint with the execution id and event id. The test checks the alert belongs to that execution and that the handler ran in n8n's `error` mode.
- **Dedupe**: an atomic insert on a unique event id (`event_claims`). First delivery: processed. Same id again: 200 `duplicate` once done, 409 `in_progress` while the first is still retrying. Six simultaneous deliveries call the API once. A failed event releases its claim so the redelivery is processed (tested: fails, API recovers, same id succeeds).
- n8n 2.x only calls an Error Workflow that is **active**. The first version of this lab had it inactive and no alert ever arrived; the tests caught it (see below).

## 4. Scheduled digest

- `Schedule Trigger` with cron `0 8 * * *`, workflow time zone `Asia/Kolkata`.
- The tests do **not** wait for 08:00. They call the same endpoint the editor's "Execute workflow" button uses (`POST /rest/workflows/:id/run` with `triggerToStartFrom: Schedule Trigger`, an internal n8n route, authenticated with the local owner session). The n8n CLI `execute` command cannot start a Schedule Trigger workflow (it only starts from a Manual or Execute-Workflow trigger), so it is not used.
- Reads `/tables/leads/rows` with `created_after` = 24 h ago and the HTTP node's pagination (`page` parameter until `has_more` is false). A busy-day test seeds 120 recent rows and 6 old ones (including one 10 minutes outside the window) and checks the three page requests, the counts (`60 pending, 40 sent, 20 send_failed`), the top-5 list and the single mail.
- Empty table, or only old rows: the execution succeeds, the `Empty day` branch runs, **no mail**.
- A table failure fails the run. Manual runs do not trigger Error Workflows in n8n (the test asserts exactly that).
- One test copies the workflow with a per-second cron, activates it and lets **the real scheduler** fire it: executions come back with mode `trigger`, the first (injected failure) alerts through the Error Workflow, a later one mails, and deactivating stops it.

## Evidence

- `evidence/executions/*.json`: real executions from a test run, reduced to status, timings and every node's output; absolute paths replaced, credential-like headers removed, and the exporter refuses to write a file that still contains a known secret.
- `evidence/screenshots/*.png`: executions rendered in the n8n editor (four of them: lead approval gate after approve, retry permanent failure, signed API low confidence, digest sent), captured headlessly with the locally installed Google Chrome through Playwright (`channel: "chrome"`), logged in with the local owner session cookie.
- `evidence/mutation-report.md` and `.json`.

## Mutation check

`npm run mutation` applies each of **49 mutants** to a copy of one workflow's JSON, starts a fresh real n8n with that copy, and runs the tests that should notice. Examples: flip an IF condition, remove the approval check (claim check always passes), send before approval (intake wired to the sender), drop the retry setting, max tries 3 to 2, wait between tries 1000 ms to 100 ms, remove the request timeout, remove the dedupe, wrong HMAC secret, sign without the timestamp, send different bytes than were signed, swap the branch outputs, move the confidence threshold, remove the Error Workflow link, point the alert at the wrong URL, remove pagination, widen the digest window, empty day sends a mail.

- Every mutant runs in **its own process tree** (`scripts/mutation-worker.mjs`: its own copy of the data folder, its own n8n on 5690, mocks and vitest). A **hard per-mutant timeout** (default 300 s, 600 s in the recorded run because the machine was shared) kills the whole tree (children are found via `ps` before signalling, so processes that left the group are included), then checks the pids are gone and the ports are free.
- **A timeout is not a kill.** It is reported as its own outcome, and any timeout, error or survivor makes the run exit non-zero.
- The unmodified workflows must pass the same tests first (baseline), and a **control mutant** that only edits a node note must **survive**, which shows the runner can tell a harmless change from a bug.
- Each edit helper throws if it cannot find what it should change, and a mutant that leaves the JSON identical is rejected, so a mutant cannot silently become a no-op.
- `npm run mutation:selftest` plants a hang (a process with grandchildren, one in its own process group, then a hang with the full n8n stack alive) and checks it is reported as a timeout, the tree is dead and the ports are free.

Result: **49 killed, 0 survived, 0 timed out, 0 errors** out of 49. The baseline (the four workflow test files, 97 tests; `local-only.test.mjs` is not part of it) passes on the unmodified workflows, and the control mutant survives, as it should. The full report is in `evidence/mutation-report.md` (outcome, number of tests that failed and the first failing test per mutant).

**What the first full run found** (48 mutants then; 45 killed, 1 survived, 2 errors), and what was changed because of it:

- *Survivor `signed-body-differs-from-signed-bytes`.* The mutant appended a space to the body after signing. Not a test gap: n8n trims that trailing space before sending (measured: the mock saw exactly the signed bytes and verified them), so the mutant changed nothing on the wire. It now puts a space inside the body after the first comma, which is still valid JSON but no longer what was signed. That version is killed.
- *Two errors, `error-workflow-unlinked` and `digest-error-workflow-unlinked`.* A harness limitation, not a verdict: updating an existing workflow through the public API without an `errorWorkflow` key keeps the old link, so the runner's read-back check refused the upload. The mutants now set an empty `errorWorkflow`, which n8n stores. Both are killed.
- *`retry-no-wait` was only killed by the stored-settings check.* n8n 2.45.7 treats `waitBetweenTries: 0` like the default and still waits about 1000 ms (measured: gaps of 1013 and 1004 ms), so the retry-timing test cannot notice it. `retry-short-wait` (100 ms) was added; the gap measurement kills it.

Those are the only changes to the mutants between the first and the recorded run; the tests were not edited to make mutants die.

## Things found while building (so you know what real n8n 2.45.7 does)

- Activation returns before the webhook is registered; the first request can 404. The harness polls until the path answers.
- An Error Workflow must be active (published) or n8n logs "is not active and cannot be executed" and does nothing.
- Public-API API keys need explicit scopes; a key with no scopes is refused.
- `n8n execute` cannot start a Schedule Trigger workflow.
- The Crypto node's HMAC needs a stored credential; the Code node needs `NODE_FUNCTION_ALLOW_BUILTIN=crypto` and `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` to sign with `require('crypto')` and read `$env`. This lab uses the Code node.
- n8n trims a trailing space off an expression result sent as a raw HTTP body, and treats `waitBetweenTries: 0` as the default (1000 ms). Both were found by the mutation check (see above).
- A workflow updated through the public API without an `errorWorkflow` key keeps its old Error Workflow link; send an empty string to clear it.
- Playwright cannot run inside vitest's module runner here (its stack-trace capture fails with `code.charCodeAt is not a function`), so `npm run evidence` takes the screenshots in a separate Node process after the tests.
- The internal Python task runner prints a harmless "Failed to start Python task runner" line at start.
- The first start of a new data folder runs about 300 database migrations (306 counted in n8n 2.45.7) and takes noticeably longer than later starts; the harness waits for `/healthz/readiness`.

## Limits and what this does not prove

- **No n8n Cloud.** Self-hosted npm package only.
- **No client workflow.** These are workflows written for this lab.
- **No Make and no Zapier.** The patterns carry over, nothing here was run on either.
- **No real Airtable, Smartlead, Apollo, Gmail, CRM or any other third-party API.** Auth flows (OAuth, API keys at a vendor), rate limits, pagination quirks, schema drift and vendor outages are not exercised. Only mock services on localhost.
- **The "LLM" is not a model.** It is a deterministic scorer (Code node) or a deterministic mock HTTP service. Nothing here shows prompt quality, model behaviour, cost or latency.
- **Local single instance**: regular mode, SQLite, one process. No queue mode, no workers, no scaling, no high availability, no restart-during-execution tests, no upgrade tests.
- **No load testing.** The heaviest case is 6 simultaneous requests.
- The `approve` webhook is **unauthenticated** in this lab. In production it needs authentication (Header Auth credential, signed approval links or an approval UI); it was left out to keep the lab about workflow behaviour.
- Retry uses n8n's fixed wait, not exponential backoff. Dedupe depends on an atomic unique-key insert in the store (the mock enforces it; a real one needs a database unique constraint or equivalent).
- The digest was run through the editor's run endpoint and a per-second copy, never by waiting for 08:00.
- The `POST /rest/workflows/:id/run` route is internal to n8n and may change between versions. The public API is the stable surface.
- Node v26 is newer than anything n8n 2.45.7 declares as tested (`>=24`); it worked here, which is all that is claimed.
- The screenshots and network check are a sample of one run.
- macOS only. Linux is untested; the CI file targets Ubuntu and has not run.

## Layout

```
mocks/                 eight mock services + the shared request-recording toolkit
src/workflows/*.mjs    workflow definitions   src/code/*.js  Code-node bodies   src/lib/  builder
workflows/*.json       the exported workflows (generated, committed)
scripts/lib/stack.mjs  start/stop mocks + n8n, API client, workflow sync
scripts/mutation-*.mjs mutation check and its per-mutant worker       scripts/lib/mutants.mjs  the 49 mutants
test/                  vitest files and helpers (run against the real stack)
evidence/              execution exports, screenshots, mutation report
```

Licence: MIT.

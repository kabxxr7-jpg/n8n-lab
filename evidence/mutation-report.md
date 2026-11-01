# Mutation check report

n8n 2.45.7, 49 mutants, **49 killed**, 0 survived, 0 timed out, 0 errors. Whole run: 35.6 minutes.
Baseline (unmodified workflows): 97 tests, 0 failed. Control mutant (a note edit, no behaviour change): survived.

| Mutant | Change | Outcome | Tests failed | First failing test |
|---|---|---|---|---|
| `gate-flip-claim-if` | flip the "Claim won?" condition | killed | 5 | lead approval gate (rules variant) approval sends exactly once, with the stored draft, only after approval |
| `gate-remove-approval-check` | the "Claim won?" check always passes (second approvals go on to send) | killed | 2 | lead approval gate (rules variant) approval approving twice does not send twice |
| `gate-send-before-approval` | intake goes straight to Send email (no approval needed) | killed | 7 | lead approval gate (rules variant) intake stores a valid lead as pending with a draft, scores it, and sends nothing |
| `gate-claim-without-precondition` | drop the if_status precondition from "Claim for sending" | killed | 2 | lead approval gate (rules variant) approval approving twice does not send twice |
| `gate-allow-resend-after-sent` | claim also accepts leads that are already sent | killed | 2 | lead approval gate (rules variant) approval approving twice does not send twice |
| `gate-skip-not-found-check` | the "Lead found?" check always passes (unknown id is not reported as 404) | killed | 2 | lead approval gate (rules variant) approval answers 404 with a clear error for an unknown id and sends nothing |
| `gate-lookup-failure-always-404` | a storage failure on lookup is reported as 404 lead_not_found | killed | 1 | lead approval gate (rules variant) approval answers 502 and sends nothing when the table API is down at approval time |
| `gate-flip-lead-valid` | flip the "Lead valid?" condition | killed | 19 | lead approval gate (rules variant) intake stores a valid lead as pending with a draft, scores it, and sends nothing |
| `gate-flip-approval-valid` | flip the "Approval valid?" condition | killed | 12 | lead approval gate (rules variant) approval sends exactly once, with the stored draft, only after approval |
| `gate-store-as-approved` | intake stores the lead with status approved instead of pending | killed | 8 | lead approval gate (rules variant) intake stores a valid lead as pending with a draft, scores it, and sends nothing |
| `gate-tier-cutoff` | medium tier starts at 65 instead of 40 | killed | 1 | lead approval gate (rules variant) intake scores the three fixture leads into three different tiers |
| `gate-budget-weight` | budget over 5000 USD is worth 10 points instead of 30 | killed | 2 | lead approval gate (rules variant) intake stores a valid lead as pending with a draft, scores it, and sends nothing |
| `gate-email-check-removed` | email format check removed from validation | killed | 2 | lead approval gate (rules variant) intake rejects bad email with 400 and stores nothing |
| `gate-wrong-recipient` | email is sent to the lead's name field instead of the address | killed | 5 | lead approval gate (rules variant) approval sends exactly once, with the stored draft, only after approval |
| `gate-failed-send-marked-sent` | a failed send is wired to "Mark sent" | killed | 1 | lead approval gate (rules variant) approval records send_failed, answers 502 and allows a retry when the email provider fails |
| `llm-no-fallback` | LLM request errors stop the workflow instead of falling back to the rules | killed | 1 | lead approval gate: mock LLM variant falls back to the rules scorer when the LLM service is down (503) |
| `llm-score-range-unchecked` | the 0-100 range check on the LLM score is removed | killed | 1 | lead approval gate: mock LLM variant falls back to the rules scorer when the LLM returns a score outside 0-100 |
| `signed-wrong-secret` | the request is signed with a different secret | killed | 9 | webhook to signed API: the signed call signs the exact bytes it sends and the API accepts the signature |
| `signed-no-timestamp-in-signature` | the signature covers only the body, not timestamp.body | killed | 9 | webhook to signed API: the signed call signs the exact bytes it sends and the API accepts the signature |
| `signed-body-differs-from-signed-bytes` | the body that is sent differs from the bytes that were signed (a space after the first comma) | killed | 9 | webhook to signed API: the signed call signs the exact bytes it sends and the API accepts the signature |
| `signed-swap-branch-outputs` | swap the true/false outputs of "Confident?" | killed | 8 | webhook to signed API: confidence branch high confidence goes straight to the callback and never touches the review queue |
| `signed-threshold-strict` | confidence >= 0.8 becomes > 0.8 | killed | 1 | webhook to signed API: confidence branch routes exactly on the 0.8 threshold |
| `signed-threshold-lowered` | threshold lowered from 0.8 to 0.5 | killed | 2 | webhook to signed API: confidence branch routes just below the threshold, 0.79 |
| `signed-no-review-queue` | low confidence skips the review queue and goes straight to the callback | killed | 3 | webhook to signed API: confidence branch low confidence goes to the review queue, then the callback says needs_review |
| `signed-no-callback-on-auto` | no callback for high-confidence events | killed | 6 | webhook to signed API: the signed call signs the exact bytes it sends and the API accepts the signature |
| `signed-callback-allowlist-removed` | callback URL allow-list removed (any host is accepted) | killed | 4 | webhook to signed API: failures and bad input answers 400 for a callback URL on another host name (localhost, not 127.0.0.1) and calls nothing downstream |
| `signed-no-failed-callback` | a rejected or failed API call is silently dropped (no failed callback) | killed | 2 | webhook to signed API: failures and bad input when the signed API rejects the signature (401), the caller gets a 'failed' callback and nothing is queued |
| `retry-off` | retry on fail switched off | killed | 7 | retry on fail succeeds on the 3rd try after two 500s, waiting between tries |
| `retry-max-tries-2` | max tries 3 -> 2 (the 3rd try never happens) | killed | 5 | retry on fail succeeds on the 3rd try after two 500s, waiting between tries |
| `retry-no-wait` | wait between tries set to 0 (n8n falls back to its 1000 ms default; caught by the stored-settings check) | killed | 1 | error workflow wiring is linked in the workflow settings that n8n stored, and points at the handler workflow |
| `retry-short-wait` | wait between tries cut from 1000 ms to 100 ms | killed | 3 | retry on fail succeeds on the 3rd try after two 500s, waiting between tries |
| `retry-no-request-timeout` | request timeout removed from the HTTP node | killed | 3 | retry on fail gives up on a hanging API after the request timeout and succeeds on the 3rd try |
| `dedupe-removed` | the dedupe check ("First delivery?") always passes | killed | 4 | dedupe a second delivery of the same event id is not processed again |
| `dedupe-claim-never-done` | a processed event stays "processing" in the claim table | killed | 5 | retry on fail processes a healthy event on the first try |
| `error-workflow-unlinked` | the Error Workflow link is removed from the workflow settings | killed | 5 | permanent failure and the Error Workflow after 3 failed tries: releases the claim, answers 502, fails the execution, and the Error Workflow records an alert |
| `failure-keeps-claim` | permanent failure does not release the claim | killed | 2 | permanent failure and the Error Workflow after 3 failed tries: releases the claim, answers 502, fails the execution, and the Error Workflow records an alert |
| `failure-not-an-error` | permanent failure no longer fails the execution (no "Fail execution") | killed | 4 | permanent failure and the Error Workflow after 3 failed tries: releases the claim, answers 502, fails the execution, and the Error Workflow records an alert |
| `alert-wrong-endpoint` | the Error Workflow posts to the wrong alert URL | killed | 3 | permanent failure and the Error Workflow after 3 failed tries: releases the claim, answers 502, fails the execution, and the Error Workflow records an alert |
| `alert-drops-event-id` | the alert no longer extracts the event id | killed | 3 | permanent failure and the Error Workflow after 3 failed tries: releases the claim, answers 502, fails the execution, and the Error Workflow records an alert |
| `digest-empty-day-sends` | the "Anything to report?" check always passes (empty day sends a mail) | killed | 2 | scheduled digest: runs started through n8n empty day: reads the table, builds a digest of nothing and sends nothing |
| `digest-flip-if` | flip the "Anything to report?" condition | killed | 4 | scheduled digest: runs started through n8n empty day: reads the table, builds a digest of nothing and sends nothing |
| `digest-no-pagination` | pagination removed (only the first 50 leads are read) | killed | 1 | scheduled digest: runs started through n8n a busy day: reads every page, counts correctly, mails one digest |
| `digest-window-ten-days` | the digest window is 240 hours instead of 24 | killed | 3 | scheduled digest: runs started through n8n empty day: reads the table, builds a digest of nothing and sends nothing |
| `digest-wrong-recipient` | the digest goes to a different address | killed | 1 | scheduled digest: runs started through n8n a busy day: reads every page, counts correctly, mails one digest |
| `digest-pending-count` | "awaiting approval" counts the sent leads | killed | 1 | scheduled digest: runs started through n8n a busy day: reads every page, counts correctly, mails one digest |
| `digest-top-list-ascending` | the top-by-fit list is sorted ascending | killed | 1 | scheduled digest: runs started through n8n a busy day: reads every page, counts correctly, mails one digest |
| `digest-error-workflow-unlinked` | the Error Workflow link is removed from the digest workflow | killed | 2 | scheduled digest: what is stored in n8n is active, runs at 08:00 in Asia/Kolkata, and is linked to the error workflow |
| `digest-schedule-changed` | the schedule is 09:00 instead of 08:00 | killed | 1 | scheduled digest: what is stored in n8n is active, runs at 08:00 in Asia/Kolkata, and is linked to the error workflow |
| `digest-timezone-utc` | the workflow time zone is UTC instead of Asia/Kolkata | killed | 1 | scheduled digest: what is stored in n8n is active, runs at 08:00 in Asia/Kolkata, and is linked to the error workflow |

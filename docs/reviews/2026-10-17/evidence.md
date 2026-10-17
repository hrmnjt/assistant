# Reproduction evidence — 17 October 2026

Baseline: [`c85e65ac75b751767b3acce5e29804aadf637684`](https://github.com/hrmnjt/assistant/commit/c85e65ac75b751767b3acce5e29804aadf637684). These observations were made during the review, before the parallel Cloudflare implementation was assessed. They are archived observations, not a claim that later branches still exhibit them.

The existing `npm test` suite passed 44 tests, and `npm run build` passed TypeScript checking and the production Vite build. Nine targeted probes used synthetic accounts, in-memory household databases, and disposable Pi databases under the ignored repository-local `.cache`. Calendar operations used a memory transport and push delivery was mocked. The API recovery probe used a temporary loopback HTTP listener.

The scratch probe programs remain disposable local artifacts. The scenarios and observed results below are the durable evidence to turn into regression tests alongside each fix. Real iCloud access, completed ChatGPT inference, actual iPhone push, tunnel operation, and device layout were not exercised.

| ID  | Scenario                                                                                                              | Observed result                                                                                                       | Classification                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| E01 | Plan deadlines for one incomplete daily task on 15, 16, and 17 October                                                | One task notice; two missed dates; notice text still names the first deadline                                         | Reproduced behavior; reminder-per-occurrence policy remains open |
| E02 | Complete a daily occurrence, reschedule onto its completed date, complete again                                       | Preview accepted, then `UNIQUE constraint failed: task_history.task_id, task_history.due_at`                          | Reproduced defect                                                |
| E03 | Plan a task notice, complete the task, then deliver with a mocked push transport                                      | The completed task's deadline notice is still sent                                                                    | Reproduced defect                                                |
| E04 | Queue 20 old appointment notices, make the calendar unavailable, then append a new task notice                        | Repeated delivery passes leave all 21 pending; the task notice is never considered                                    | Reproduced defect                                                |
| E05 | Apply a direct calendar create remotely, lose the response, then fetch authenticated state as a reloaded client       | Remote record exists and operation has `attempted=1`; neither household state nor any chat status exposes its preview | Reproduced defect                                                |
| E06 | Lose a successful create response, edit the remote record as a human, advance beyond preview expiry, retry and cancel | Retry incorrectly says the prior attempt was not applied; cancellation also refuses; `attempted=1` remains            | Reproduced defect                                                |
| E07 | Persist 205 ordinary channel messages, then fetch messages                                                            | Only 200 returned; the first message is absent and the API exposes no page cursor                                     | Reproduced limitation; stored history remains intact             |
| E08 | Call `boundedModels().completeSimple` through a faux provider                                                         | One provider call succeeds while `assistant_model_calls` remains empty                                                | Reproduced budget-boundary gap                                   |
| E09 | Reopen without AI configuration, persist a queued AI request, then send with `askAssistant=false`                     | The ordinary human message is rejected for an unfinished AI request                                                   | Reproduced defect                                                |

## Calendar recovery: E05 and E06

Use the existing `CalendarTransport` interface with an in-memory map. Its `put` saves the resource and then throws, representing a lost response after a successful external write. Create and confirm a preview. Verify the remote resource exists even though confirmation returns an error.

For E05, open `Conversations`, construct `createApp`, sign in using a synthetic account, and request `/api/state`. Inspect each thread's assistant status. The preview ID is present in SQLite but absent from every client recovery response. This establishes API reachability after a reload; it is not a real-device reload test.

For E06, replace the remote resource using `updateEventData` with a human edit and a new ETag, advance the injected clock by eleven minutes, and retry confirmation and cancellation. Both fail despite the earlier successful write. Cover both pre-expiry conflict and post-expiry outcomes when adding regression tests.

Evidence: [calendar confirmation](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/calendar.ts#L340), [cancellation](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/calendar.ts#L320), [client state](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/app.ts#L42), [assistant preview visibility](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/conversations.ts#L178).

## Recurrence and delivery: E01–E04

Use synthetic `owner` and `partner` accounts, disable daily summaries to avoid unrelated notices, and create task mutations through the normal preview/confirm path. E01 starts at `2026-10-15T06:00:00.000Z` with a daily Asia/Dubai schedule and plans at 07:00 UTC on each of three dates.

E02 completes revision 1, updates revision 2 back onto the completed due date, then confirms a completion preview for revision 3. The final history insert collides with the existing occurrence key.

E03 creates an overdue one-off task, calls `plan`, completes the task, and calls `deliver` while recording mocked `webpush.sendNotification` payloads. The payload still contains that deadline notice. Reassignment, rescheduling, and deletion were identified as related missing checks by code inspection and should receive separate regression cases.

E04 seeds 20 appointment notices older than the delivery age limit, sets the calendar snapshot to `error`, appends a newer task notice, and calls `deliver` twice. The same oldest batch is skipped before age checks, leaving the new task pending.

Evidence: [recurrence history insert](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/domain.ts#L316), [task notice planning](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/reminders.ts#L74), [delivery selection and validation](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/reminders.ts#L129).

## History and Pi integration: E07–E09

E07 sends 205 messages with distinct request UUIDs and `askAssistant=false`. Fetching messages returns the latest 200. Model/tool entries can reduce the number of human-visible messages within the same entry limit.

E08 installs a faux provider, wraps the Models collection with `boundedModels`, calls `completeSimple` once, and compares the provider call count with `assistant_model_calls`. Pi's installed compaction implementation uses this method, whereas the wrapper only intercepts `streamSimple`. This probe validates the method boundary; it does not claim a full long-conversation compaction run was exercised.

E09 opens Pi storage with no configured model, seeds a queued `assistant_runs` row attributed to the owner, then sends an ordinary message from the partner with `askAssistant=false`. It is rejected before the passive-write path.

Evidence: [history window](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/conversations.ts#L119), [model wrapper](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/assistant-tools.ts#L31), [send admission](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/conversations.ts#L210).

## Findings established by inspection

The slow-send draft race, stale-editor recovery, mention matching, OAuth dependency conformance, startup/shutdown gaps, missing operational tooling, and absent CI/browser coverage were established by code or dependency inspection. They were not browser, real-provider, security exploit, or deployment tests. Each follow-up should add the regression or acceptance evidence appropriate to its scope.

# Household assistant review — 17 October 2026

The product direction is coherent: help two spouses capture responsibilities, agree on changes, see one shared calendar, and follow through. The next milestone should establish reliable everyday use across phones, restarts, and network failures.

Baseline: [`c85e65ac75b751767b3acce5e29804aadf637684`](https://github.com/hrmnjt/assistant/commit/c85e65ac75b751767b3acce5e29804aadf637684). This is a dated assessment of that committed application; concurrent Cloudflare prototype work is outside its scope. Code evidence links below are pinned to the reviewed commit.

Validation during the review: all 44 existing tests passed; the TypeScript check and production build passed through `npm run build`. Seven additional edge cases were reproduced using synthetic data and mocked calendar/push transports. Their setup and observed results are preserved in [reproduction evidence](evidence.md). No application fixes were made. Recommendations here are proposals unless already confirmed in the root README.

The later [architectural review](architecture.md) compares the integration with the supplied Pi Durable references and the official Cloudflare sample. It adds two reproduced integration behaviors, for nine targeted probes in total.

Real iCloud access, actual ChatGPT inference, iPhone Home Screen push, tunnel operation, and device layout were not exercised. These remain acceptance checks, not implied successes from the automated suite.

The existing strengths are worth preserving: server-side credentials, hashed session tokens, actor-bound previews, atomic local task confirmation, revision checks, CalDAV ETag preconditions, stable identities for calendar edits, persisted requests, and an assistant with no tool capable of confirming a change. The existing tests meaningfully cover these boundaries.

## Findings to address first

### 1. High: uncertain calendar writes can become impossible to resolve

Evidence: [server/calendar.ts:320](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/calendar.ts#L320), [server/calendar.ts:340](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/calendar.ts#L340), [server/calendar.ts:370](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/calendar.ts#L370); reproduced with a remote write whose response was lost.

After a PUT succeeds remotely but its response is lost, `attempted=1` is retained. If a human then edits that appointment, the exact field comparison no longer recognizes the original write. Confirmation reports a conflict, or after expiry says the previous attempt was not applied. Cancellation still refuses because an attempt was made. Neither action reaches a terminal outcome. The expiry message can therefore be factually wrong: the write did happen.

Give operations explicit outcomes for applied, conflicted, failed, and unknown results. Reconcile uncertain operations without rewriting an expired proposal. A human edit after a successful write must be represented as a subsequent change. Provide an honest way to review and dismiss a remaining uncertainty. Add tests for lost responses followed by external edits, deletion, expiry, and process termination.

### 2. High: durable confirmation state is not recoverable through the UI

Evidence: [server/app.ts:42](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/app.ts#L42), [server/conversations.ts:178](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/conversations.ts#L178), [src/main.tsx:166](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/src/main.tsx#L166); reproduced through the HTTP state endpoint.

A direct calendar preview survives in SQLite, but its ID exists only in React state on the client. `/api/state` does not expose recoverable previews. Chat status exposes only assistant-created, unexpired previews. Reloading the app after an uncertain direct write loses access to the very preview the server tells the user to retry. Expired assistant previews also disappear even when a previous write still needs reconciliation.

Expose actor-owned pending operations and unresolved attempted operations through an authenticated recovery endpoint. Restore them on login and reload, and provide a visible result history. An expired permission to perform a new write and an unresolved result of a previous attempt need different treatment.

### 3. Medium: task pushes can describe work that is already completed or rescheduled

Evidence: [server/reminders.ts:74](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/reminders.ts#L74), [server/reminders.ts:129](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/reminders.ts#L129); reproduced by completing a task between planning and delivery.

The queued deadline notice was still pushed after completion. Calendar notices receive a current-state check; task notices do not. Reassignment, deletion, and due-date edits have the same missing validation boundary.

Store a typed task/occurrence reference with each deadline notice. Before sending, check that the occurrence is still open, has the same deadline, and belongs to the intended recipient. Preserve historical inbox information separately from whether a push is still useful.

### 4. Medium: blocked calendar notices can starve unrelated notifications

Evidence: [server/reminders.ts:133](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/reminders.ts#L133); reproduced with 20 earlier appointment notices and a newer task notice.

Delivery repeatedly selects the oldest 20 pending notices. When the calendar is unavailable, appointment notices are skipped before their age is examined. Those same rows can occupy the entire batch indefinitely, preventing newer task reminders, summaries, or partner updates from being considered. Old appointment rows can remain pending even beyond the two-hour delivery cutoff.

Expire stale jobs before dependency checks. Give blocked jobs a future retry time and bounded backoff, and ensure one unavailable integration cannot occupy every delivery slot. Record attempts and the latest safe diagnostic category.

### 5. Medium: recurring tasks need an explicit occurrence and rescheduling policy

Evidence: [server/domain.ts:70](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/domain.ts#L70), [server/domain.ts:128](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/domain.ts#L128), [server/domain.ts:316](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/domain.ts#L316), [server/reminders.ts:74](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/reminders.ts#L74); two cases reproduced.

- A daily chore left incomplete across three deadlines produced one deadline notice. Its missed count reached two, but the stored notice still described the first deadline. This is a confirmed behavior; whether each scheduled occurrence should notify is a product decision that the current specification should settle.
- Completing an occurrence, rescheduling the task onto that completed date, and completing again passes preview validation but throws a SQLite uniqueness error on confirmation. The accepted update creates a state that the completion path cannot handle.

Represent the schedule, active occurrence, and historical outcomes distinctly, while preserving the agreed overdue-deadline behavior. Define what happens when a schedule is edited onto a completed or missed date: reject the proposal clearly, explicitly reopen an occurrence, or start a new schedule version. Add occurrence-level completion timestamps; the current history row records a due date and actor, while the separate audit table records completion time without an occurrence identifier.

## Chat and interaction reliability

### 6. Medium: a slow send can erase newer draft text

Evidence: [src/main.tsx:1005](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/src/main.tsx#L1005); identified by code inspection, not browser reproduction.

The textarea remains editable while the send request awaits its response. On success, the handler unconditionally calls `setDraft('')`. Text typed after submitting can be discarded. Navigation also remains available; the old handler can later set messages and status for its captured thread after the active page changes.

Capture the submitted draft and thread identity. Clear only that submitted draft, preserve text entered later, and apply results only to the current thread/login. Use per-thread draft state and guard or abort stale reads. Test slow responses, page changes, and a failed response after the server accepted a message.

### 7. Medium: persistent history becomes inaccessible after a fixed window

Evidence: [server/conversations.ts:119](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/conversations.ts#L119), [server/app.ts:64](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/app.ts#L64); chat behavior reproduced.

Sending 205 ordinary channel messages returned only the latest 200. The limit applies to Pi entries, so model and tool entries can reduce the number of actual chat messages available. The API drops the pagination cursor and the UI offers no older-history control. Older data remains stored but cannot be retrieved through the app. Updates have a similar unpaginated 20-row window, including unread entries.

Add cursor pagination for chat and Updates, and calculate unread counts independently of the displayed page. Define a deliberate retention policy separately from display pagination.

### 8. Medium: shared-channel assistant invocation is narrower than the UI promises

Evidence: [src/main.tsx:1019](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/src/main.tsx#L1019); code inspection.

The UI says to mention `@assistant`, but its regular expression only recognizes a mention at the beginning of the message. “Could @assistant help with this?” is sent as an ordinary human message. Recognize the documented mention behavior anywhere in the message, with clear token boundaries, and make the invocation decision visible before send.

Shared channels would also benefit from unread indicators and an explicit decision about human-message push notifications. Currently ordinary channel messages are persisted and polled while that thread is open, without a channel unread or notification mechanism.

### 9. Medium: stale-edit recovery leaves the editor holding the stale version

Evidence: [src/main.tsx:288](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/src/main.tsx#L288), [src/main.tsx:1270](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/src/main.tsx#L1270), [src/main.tsx:1309](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/src/main.tsx#L1309); code inspection.

The server correctly rejects stale task revisions and calendar ETags. The form, however, retains its original object. Returning from a rejected preview and submitting again can repeat the same conflict until the person closes and reopens the editor.

Fetch the current record after a conflict, preserve the person's intended changes, and present a new comparison. A clear “Reload current version” action would be a sufficient initial improvement. The product specification already promises a refreshed proposal when the target changes.

## AI access and product validation

### 10. High-priority validation: the central assistant experience remains unproven with the real account

Evidence: `README.md:16`, [scripts/chatgpt.ts:45](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/scripts/chatgpt.ts#L45), [server/ai.ts:126](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/ai.ts#L126), `tests/assistant.test.ts`.

The tests establish tool wiring, queueing, and some streaming behavior using a faux provider or mocked fetch. They do not establish successful subscription-backed inference for this installation, the selected account/model, or the desired shared use by both spouses. `configured` means credentials and a catalog model are present, rather than that a completed request was observed.

The reviewed [official OpenAI overview](https://developers.openai.com/siwc/token-sharing-open-source) describes authorization tied to a user and workspace. It does not settle this application's shared-subscription eligibility question. Keep that unresolved until validated. The [inference documentation](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) requires a completed stream; a catalog response alone is insufficient.

Add distinct connection states such as configured, verified, temporarily unavailable, and reconnect required. Complete one real inference, refresh/restart recovery, and usage-limit recovery before treating AI setup as complete. Preserve the agreed absence of an automatic API billing fallback.

### 11. Medium: audit the pinned OAuth dependency against the documented flow

Evidence: [server/ai.ts:93](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/ai.ts#L93), [scripts/chatgpt.ts:31](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/scripts/chatgpt.ts#L31); inspected the installed `@earendil-works/pi-ai` 1.2.0 implementation.

The dependency generates a nonce but only checks that an ID token exists; it does not verify its signature, audience, issuer, expiry, or nonce, and it discards the ID token. It also starts each login with dynamic client registration rather than reusing the saved issued client ID. The host UUID is correctly normalized to a `urn:uuid:` URI by the dependency.

These identity-validation and returning-client behaviors differ from the [official sign-in guidance](https://developers.openai.com/siwc/token-sharing-open-source/sign-in). This is an integration conformance gap; application login is separately implemented, so this finding does not establish a household authentication bypass. Add focused OAuth contract tests and use or implement a flow that meets the documented requirements.

### 12. Medium: failures need actionable diagnoses and per-message outcomes

Evidence: [server/conversations.ts:173](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/conversations.ts#L173), [server/conversations.ts:310](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/conversations.ts#L310), [scripts/chatgpt.ts:71](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/scripts/chatgpt.ts#L71).

The application deliberately hides raw provider errors, which protects credentials and content. It also collapses quota exhaustion, revoked authorization, unsupported requests, and transport failures into one message. The latest run determines chat error display, so a later successful queued request can conceal an earlier failure.

Persist a safe failure category, request correlation ID where available, and a status for each submitted message. Pause queued inference when the account hits a usage or authorization restriction. Keep safe operational diagnostics available to the owner. The [official recovery guidance](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) distinguishes these conditions and their remedies.

Add a small behavioral evaluation set for ambiguous owners, tomorrow/next-week dates, time zones, dictation mistakes, duplicate requests, stale proposals, and conversational “yes.” Faux-provider tests cannot establish whether the real model asks the right clarifying questions.

## Operation, maintenance, and scope

### 13. Before routine use: establish restore, restart, and credential procedures

There is no repository backup/restore command, restore verification, process supervision configuration, or health endpoint. Household and Pi conversation state live in separate SQLite databases, so a backup should capture a consistent recovery point across both rather than independently copying live files. Include the protected push-key and AI-configuration material as appropriate, with credentials handled deliberately.

The shutdown path ([server/index.ts:83](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/index.ts#L83)) closes the HTTP server without awaiting in-flight requests, calendar sync, or push delivery before closing the database. Add an orderly drain, bounded shutdown, and a restart test with active work. A corrupt optional AI credential file currently prevents application startup through `openAIConnection`; consider degrading assistant availability while preserving tasks and reminders.

Provide a local command to rotate household passwords and revoke sessions. [server/auth.ts:25](https://github.com/hrmnjt/assistant/blob/c85e65ac75b751767b3acce5e29804aadf637684/server/auth.ts#L25) intentionally provisions only once, so editing `.env` does not update existing accounts. Record that distinction prominently in setup guidance. Bound and clean up sign-in rate-limit state, and consider asynchronous password derivation to keep unsuccessful public-hostname login traffic from blocking the single event loop.

Agree on quiet hours and catch-up behavior. Current implementation choices include a two-hour summary catch-up, two-hour appointment planning window, two-hour push retry age, and effectively indefinite overdue-task capture. These are distinct policies, while the README still lists catch-up and quiet hours as unresolved.

### 14. Improve change safety with focused boundaries and continuous checks

The single Node service and SQLite are proportionate to two users. Preserve that simplicity. Refactor the frontend around actual responsibilities: chat state/composer, task editing, preview/recovery, Updates, and settings. `src/main.tsx` contains 1,767 lines, and `src/styles.css` has 2,652 lines with several successive override layers. Consolidate styles as those surfaces are touched to make changes predictable.

Keep scheduling and delivery behind testable clock and transport boundaries. Use typed notice targets and a small explicit operation lifecycle rather than interpreting IDs or combining booleans. Introduce schema versioning before modifying real household databases; `CREATE TABLE IF NOT EXISTS` alone cannot evolve an existing table.

Add CI for the existing test suite and build, then a small browser suite for the highest-risk interactions. Prioritize meaningful missing checks: slow mobile requests, recovery after reload, stale edits, reminder cancellation/reassignment, multi-device push results, actual expanded CalDAV recurrence fixtures, long conversation pagination, and abrupt restart recovery.

Keep a short acceptance matrix distinguishing automated, mocked, manually verified, and unresolved behavior. The fourteen README scenarios already provide a useful starting point. Product proposals in this report are recommendations, not newly agreed requirements.

Use hosting requirements derived from the implementation: persistent local state, background scheduling, credential refresh, and a reliable process lifecycle. Cloudflare Tunnel provides access to the Mac service; any future compute move should explicitly account for those responsibilities. Keep the Mac, Linux PC, dedicated-server, and Cloudflare options open as agreed.

## Suggested implementation order

1. Repair calendar operation outcomes and recovery through the UI, including reload and expiry.
2. Repair reminder validation and delivery fairness; settle occurrence and catch-up policies.
3. Repair recurring-date collisions, then chat draft safety and history pagination.
4. Validate actual iCloud edits, completed ChatGPT inference, and push on both installed iPhones through the stable hostname. Include a Mac restart and an external calendar edit.
5. Add consistent backup/restore, health visibility, safe diagnostics, and CI.
6. Refactor the affected frontend surfaces and consolidate styling while continuing the agreed POC scope.

The existing foundations support this sequence. The most valuable improvement is to make each accepted responsibility and confirmed action dependable and understandable under ordinary interruptions.

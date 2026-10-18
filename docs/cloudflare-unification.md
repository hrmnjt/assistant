# One household application, local and deployed

## Confirmed direction

Cloudflare is the deployment target. The Mac is a development/test machine,
not the long-term service host. Run the same Worker/Durable Object application
locally with Wrangler and deployed to Cloudflare. Preserve the agreed POC:
two sign-ins, independent assistant histories, shared channels/tasks/calendar,
explicit actor-bound confirmation, Updates, summaries, and iPhone push.

There are currently **two implementations**, not two complete equivalent apps:

- `server/` + `src/`: the full Node/Express/SQLite application and React client.
- `cloudflare/`: a separate Pi/SQLite Durable Object compatibility prototype,
  fixture chat, test jobs, and optional read-only calendar/push probes. Its
  vanilla-JS probe client is not a port of the product UI.

Selecting Cloudflare does not make the prototype production-ready. Do not remove
the working application or claim migration/acceptance before parity is tested.

## Proposed implementation boundaries

- **One application core:** task/occurrence rules, calendar confirmation and
  reconciliation, actor/request identity, notices, and API read models. Reuse
  corrected behavior and tests; do not reimplement these independently for Node
  and Cloudflare. Keep `src/` as the product client, not a second Cloudflare UI.
- **One household runtime:** one Durable Object is the consistency boundary for
  both people, shared records, and separate Pi conversations. Domain tables own
  household records and effect/command receipts; Pi owns its inbox/run/transcript
  lifecycle. Application status indexes must be rebuildable, not a second queue.
- **Storage:** port synchronous Node SQL paths to the supported serialized
  transaction/command boundary before sharing SQLite with Pi. A single database
  file does not make separate transactions atomic. Keep domain writes,
  proposal/command receipts, and effect intents atomic where possible; use stable
  command IDs and a durable reconciliation/outbox bridge across boundaries.
  No direct host SQL writes bypassing Pi's queued Cloudflare adapter.
- **Host adapters:** storage/transactions, clock/wakeup scheduling, credential
  persistence/refresh, CalDAV, push, and model access. Node becomes a temporary
  reference/test adapter rather than a separately maintained deployment.
- **Independent durable jobs:** persist ownership, checkpoints, stable effect IDs,
  retry deadlines, and the next alarm before enabling network work. Cold start
  repairs wakeups. Calendar/reminder delivery must work with AI unavailable.
- **One product protocol:** authenticated application snapshots/commands shared by
  local and deployed clients; do not expose experimental Pi wire types as the
  browser contract. Streaming/reconnect details remain #33 work.

These boundaries are a plan, not an implemented abstraction or a reason to
rewrite all services at once. Main architecture work remains #30–#32; migrations,
backup/restore, supervision, and conformance remain #25–#27 and #35.

## Migration and validation order

1. Land P1 calendar correctness/recovery (#9, #10) and preserve those regressions
   in the shared core. Account/device acceptance is tracked separately in #24.
2. Establish versioned storage, stable command receipts, actor-bound Pi admission,
   and narrow adapters; test crashes/reopen and storage conformance.
3. Serve the existing React client and equivalent API from the Worker/household
   DO. Port tasks, calendar writes, channels, Updates, preferences, and durable
   reminders; test the same behavior locally in workerd, not just Node mocks.
4. Configure a deployment once with protected credentials, stable VAPID keys, and
   a stable HTTPS hostname. Verify real calendar identity/conflicts, eligible
   ChatGPT inference/refresh, installed phones, reconnect and restart/eviction.
   Choosing Cloudflare does not establish hosted/shared ChatGPT-plan eligibility.
   Keep AI optional with no automatic billing fallback.
5. Test a coordinated export/restore into isolated data and rollback. Choose the
   authoritative household state explicitly: existing Mac data and disposable
   prototype data are never imported implicitly. Stop the old scheduler before
   cutover; only one runtime may deliver household effects.
6. Retire the probe-only client and duplicated Node orchestration after parity
   and recovery acceptance. Keep integration probes as tests, not a second app.

No deployment, data migration, credential transfer, or live-provider validation
is performed by this documentation change.

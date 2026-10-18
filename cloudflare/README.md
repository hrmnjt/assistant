# Cloudflare compatibility prototype

Cloudflare is now the selected deployment target. This isolated prototype tests
that approach but is not yet the product application: Worker static
assets and API routing, with a single SQLite-backed `HouseholdPrototype` Durable
Object containing Pi and the prototype's own tables. It is a shared test space
for the two spouses, separate from the Mac app's tasks and conversations.
The household application has not yet been ported or migrated. The agreed
[unification direction](../docs/cloudflare-unification.md) is one shared core,
React client, API, and Worker/DO runtime, tested locally through Wrangler on the
Mac and deployed to Cloudflare. Do not maintain this probe client as a second
feature implementation or treat the Node host as the long-term deployment.

## Run on the Mac

Use the repository's Node 24+ installation and local dependencies:

```sh
npm ci --cache ./.cache/npm --ignore-scripts
npm run cloudflare:configure
npm run cloudflare:dev
```

Open `http://localhost:8787`. The configuration command creates private
`cloudflare/.dev.vars` with generated `owner` and `partner` passwords and stable
VAPID keys. It never overwrites an existing file. Edit it using
[.dev.vars.example](.dev.vars.example) as a reference. The app requires an exact
`APP_ORIGIN`, including scheme and port. HTTPS is required outside local testing.

State stays under `data/cloudflare/`; tooling, logs, bundles and test artifacts
stay in `.cache/`. The runner redirects Wrangler's temporary `.wrangler` path
into that cache. Local Wrangler configuration/authentication is also kept there.
The local emulator stops when its process stops; only a cloud deployment can run
while the Mac is off.

## What to try

1. Sign in, send a note, and wait for the fixture response. No model API is called.
   Sign in as the other account to see the same test conversation and jobs.
2. Schedule a reminder, close the page, then return to see its completed result.
   Restart the local Worker between scheduling and delivery to check persistence.
   The instance ID changes when the Durable Object is recreated.
3. Optionally configure `ICLOUD_USERNAME`, `ICLOUD_APP_PASSWORD`, and
   `ICLOUD_CALENDAR_NAME` (default `Household`). Use an Apple app-specific password.
   Use `ICLOUD_CALENDAR_URL` when names are ambiguous. Restart the Worker, then
   run the read-only iCloud test. It performs discovery and reads this UTC month's
   event count. It does not test appointment writes or change the calendar.
4. For phone push, configure a real `PUSH_CONTACT` mailto address and retain the
   generated VAPID keypair. Use a stable HTTPS cloud hostname. On iPhone, install
   Cloud Lab on the Home Screen, open it, sign in, enable phone push, and schedule
   a reminder. Confirm the notification on the phone with the page closed.
   A push service accepting a request does not establish device display.

Each browser's push subscription belongs to the account that enabled it. Enabling
push after switching accounts reassigns that browser's subscription. Both accounts
can see the test jobs, but reminder push goes to the requesting account.

## Deploy the isolated prototype

No deployment occurs during build or tests. The included Worker name and
Durable Object namespace are dedicated to this prototype. Keep them separate
from any future production app and retain them across subsequent deployments.

Authenticate Wrangler from inside this repository:

```sh
npm run cloudflare:wrangler -- login
```

In `wrangler.jsonc`, keep `MODEL_MODE` set to `fixture`. Set `APP_ORIGIN` in `vars`
to the intended exact HTTPS origin, for example your Worker's
`https://household-assistant-prototype.<subdomain>.workers.dev` address. Find the
account's workers.dev subdomain in the Cloudflare dashboard. For a custom domain,
configure the Worker route/domain and use that origin instead.

Create the two distinct password secrets (at least 12 characters), then deploy:

```sh
npm run cloudflare:wrangler -- secret put OWNER_PASSWORD --config cloudflare/wrangler.jsonc
npm run cloudflare:wrangler -- secret put PARTNER_PASSWORD --config cloudflare/wrangler.jsonc
npm run cloudflare:check
npm run cloudflare:deploy
```

Use the same `secret put <NAME> --config cloudflare/wrangler.jsonc` command for
optional `ICLOUD_USERNAME`, `ICLOUD_APP_PASSWORD`, `VAPID_PUBLIC_KEY`, and
`VAPID_PRIVATE_KEY`. Configure non-secret `ICLOUD_CALENDAR_NAME`,
`ICLOUD_CALENDAR_URL`, and `PUSH_CONTACT` in `vars`. Keep private values out of
Git and command arguments. `.dev.vars` only configures local development; it is
not uploaded as cloud secrets. The Worker fails closed when passwords or origin
are missing. Unknown API routes return JSON errors, not the static test page.

Run the checks above again against the cloud hostname. Actual Cloudflare account
provisioning, iCloud access, phone delivery, and any paid model access remain
unverified until those checks are performed with the user's account and device.

## Recovery and delivery semantics

Job admission, request-ID conflict checks, queue capacity (10), and its next alarm
commit in one transaction. Every host SQL operation, Pi storage transaction, and
alarm write uses one serialized database adapter. `prototype_` table names avoid
collisions with Pi 1.2.0's unprefixed tables. Do not mix direct host SQL writes
with that adapter during normal operation.

The alarm processes at most two due jobs per invocation, persists each result,
and schedules the next pending job. It arms a recovery wakeup before network
work; cold initialization also repairs missing wakeups for persisted work.
An empty queue removes the alarm. Failed calendar/push probes retry up to three
attempts with backoff, then expose a generic error. Provider failures are visible
and do not automatically trigger another paid request. Model calls have a
90-second timeout and provider retries are disabled.

A restarted chat job resubmits its original Pi request ID. A committed reply is
not generated again. Interruption during an uncommitted provider request can
still repeat that external request. Push records successful deliveries per device
and removes expired subscriptions. A crash after remote acceptance but before
recording success can repeat a push; notification tags reuse the job ID. These
are retry-safe records, not a promise of exactly-once external delivery.

Fixture and live model modes share this prototype's test conversation. Keep
fixture data disposable. The main app's per-login histories, confirmation tools,
tasks, summaries, presence and calendar editing are not part of this prototype.

## Optional ChatGPT adapter

Hosted ChatGPT eligibility, shared-plan eligibility, and completed inference for
this installation are unresolved. The default fixture mode requires no OpenAI
credentials. No API-key fallback exists. The experimental adapter requires all
of `MODEL_MODE=chatgpt`, `ALLOW_HOSTED_CHATGPT=true`, a supported
`CHATGPT_MODEL_ID`, and a separately authorized OAuth credential supplied as the
`CHATGPT_CREDENTIAL_JSON` secret. It does not read the Mac app's or Codex's files.

If eligibility is established, authorize a separate installation using a stable
host ID and preserve its full OAuth metadata, including issued `clientId`. The
bootstrap secret is imported only when no credential is stored. Token refreshes
are serialized and replacements persist in the object's private SQLite storage.
Changing the bootstrap secret does not overwrite an already-rotated credential.
There is no hosted reconnect UI yet; reconnect/revocation and credential
replacement must be designed before the full app moves to cloud hosting.

Official guidance distinguishes [open-source/local usage and hosted apps](https://developers.openai.com/siwc/token-sharing-open-source)
and documents [self-hosted VM setup](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms).
Neither establishes this Cloudflare installation's eligibility.

## Validation and next migration step

```sh
npm test
npm run build
npm run cloudflare:check
```

The suite includes workerd tests for login/origin/body limits, concurrent job
admission and retries, alarm scheduling and bounded failure recovery, destroying
and reopening an object, Pi request replay, serialized OAuth refresh, real CalDAV
client discovery/REPORT/parsing with mocked HTTP, and Web Push encryption and
per-device retry handling with mocked HTTP. No real provider or calendar account
is contacted by these tests.

Before migrating the full app: validate the live probes and model access; port
the app's database operations, routes and confirmation flow; add durable summary
and calendar-sync scheduling; prepare a consistent export/import of both local
SQLite databases; test backups, restore and rollback; then choose a cutover that
keeps only one scheduler active. Existing Mac data is never imported implicitly.
Code rollbacks should retain the Durable Object class, binding, migration history
and object name so they continue addressing the same storage.

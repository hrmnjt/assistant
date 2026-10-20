# Assistant

Updated: 2026-10-19. Status: one Cloudflare application, the `assistant`
Worker. The same Worker and its Durable Object run locally through Wrangler on the Mac for development
and on Cloudflare when deployed. There is no separate Node server. The app
starts fresh, with no data imported. Direction (decided 18 October 2026): chat
drives the whole app, and tasks, calendar and the dashboard become plugins; see
[Chat-driven assistant](#chat-driven-assistant) for what is built and what is next.

## Purpose

A personal assistant for two spouses, starting with a calendar and tasks and
potentially expanding to documentation later. It is for their own use, with no public
registration or product offering. The primary goal is to make appointments and
unfinished responsibilities easy to capture, see, and follow up on.

## Current build

The MVP has two household accounts, shared tasks with confirmation previews,
daily/weekly chores with missed-date history, per-person summary settings, and
topic messages persisted through Pi Durable. An iCloud agenda supports confirmed
appointment creation, edits, and deletion against the original records. The
assistant can read household information and prepare the same confirmation
previews from chat. Phone push, a real iCloud round trip, and completed ChatGPT
inference still need verification with the user's accounts and devices.

**Architecture.** A Worker serves the built React client as static assets and
sends `/api/*` to one SQLite-backed Durable Object, `Household`. That object
holds both accounts, the shared records, and the Pi conversations, which share
its SQLite storage through one serialized queue. A single alarm runs calendar
refreshes, reminders, summaries, and recovery of unfinished assistant work.
`server/` holds the core (who is signed in, people and settings, conversations and
channels, the change pipeline, notices and push, the API router) and
`server/plugins/` the features built on it; `cloudflare/worker.ts` is the only
host, and `src/` is the client.

### How we work

Everything happens from the phone. Features are requested in a Claude Code chat,
which opens pull requests on GitHub; they are reviewed and merged ("Rebase and
merge") in the GitHub app; GitHub Actions tests each merge to `main` and deploys
it to the `assistant` Worker; the app is used in Safari and installed on each
Home Screen, behind Cloudflare Access. Running locally is optional, for
checking something specific. Nothing needs a computer: settings, ChatGPT
included, are made on the app's admin page.

### Run locally (optional)

Use Node.js 24 or newer. All project data, caches, and scripts stay in this repo.

```sh
npm ci --cache ./.cache/npm --ignore-scripts
npm run dev
```

Open `http://localhost:8787/admin` (or `http://127.0.0.1:8787/admin`) and add
the two people (emails are optional locally), then open `http://localhost:8787`.
Development has no sign-in and no admin token: it answers only on this computer
and acts as the first person; Settings has an "Act as" button to try shared
features as the second. ChatGPT connects on the admin page as on a deployment. `npm run dev` runs `wrangler dev` with the client
rebuilt on each change (reload the page to see it). Local state lives in
`data/cloudflare/` and survives restarts; delete that folder to start over. The
local app stops with its process. Phones use the deployment.

### Deploy to Cloudflare

Cloudflare Access signs the two people in; the app has no passwords of its own.
With Access enabled on the Worker, Cloudflare gives it the verified email of
each request (`ctx.access`); the Worker passes that on to the app, which
recognizes only the two emails the admin added. A deployment without Access
refuses every request.

The admin page, `/admin`, is separate from the two people's app: it sits behind
Access too and also needs `ADMIN_TOKEN`, a Worker secret. There the admin adds
the two people, connects the iCloud calendar and chooses the assistant's model.

1. Deploy the Worker: `npm run wrangler -- login`, then `npm run deploy` (or
   let [continuous deployment](#continuous-deployment) do it). It appears as
   `assistant.<subdomain>.workers.dev`.
2. In the Worker's Settings → Domains & Routes, enable Cloudflare Access for
   workers.dev. In Zero Trust → Access, edit the Worker's policy so it allows
   exactly the two email addresses.
3. In Settings → Variables and Secrets, add `ADMIN_TOKEN` as a Secret: at least
   32 random characters, from a password manager.
4. Open `/admin`, sign in with that token, and add both people's names and the
   emails Access allows. The page also shows which email Access verified for
   the request, to check Access reaches the app.
5. Optional, on the same page: connect the shared iCloud calendar (an Apple ID
   and an app-specific password, then the calendar to share).
6. Optional, on the same page: connect ChatGPT (see [AI access](#ai-access))
   and choose the assistant's model.

Push keys need no configuration: the app makes them on first start.

`npm run deploy` uploads code only and keeps the Worker's variables and
secrets. Run `npm run check` first to typecheck and
build the bundle without uploading. Keep the Durable Object class, binding, and
migration history on later deploys so they keep addressing the same storage.
There is no export or backup command yet.

### Continuous deployment

After the checks pass on `main`, GitHub Actions deploys the Worker (code only;
the Worker's variables and secrets are kept). It needs two repository secrets
(Settings → Secrets and variables → Actions): `CLOUDFLARE_ACCOUNT_ID`, the
account ID from the Cloudflare dashboard, and `CLOUDFLARE_API_TOKEN`, a token
made from the "Edit Cloudflare Workers" template for that account. The deploy
job runs in the `production` environment, one deploy at a time; add a required
reviewer there to approve each deploy. Run the CI workflow manually to redeploy
`main`. Use this as the only deployment path: if the repository is also
connected to Cloudflare's own Git builds, disconnect them, so a push does not
deploy twice or to a second Worker.

### Accounts and settings

The two people's names and emails live only in the app's storage on Cloudflare,
never in the repository or GitHub. Only the admin changes them, on the admin
page; each person keeps their records when a name or email changes, and a
changed email must also be allowed in Access. The admin's sign-in lasts 12
hours, five wrong tokens lock it for 15 minutes, and a new `ADMIN_TOKEN` ends
every admin session. The people's Settings show both names and the connections'
status. Email addresses are not
sent to ChatGPT; the assistant reads names only. Sign out (Settings) ends the
Access session; Access decides how long a sign-in lasts. Use the deployment's
stable HTTPS address on phones, which the service worker and push require.

Phone push needs no setup: the app makes its Web Push keys once and keeps them
(new keys would break existing phone subscriptions), with the app's own address
as the push services' contact, so neither email goes to Apple or Google. Without notification
permission, reminders stay available in the app's Updates.

To connect the calendar, create and share the iCloud calendar in Apple
Calendar, then on the admin page sign in with an Apple ID and an Apple
app-specific password and pick the calendar. The password is kept in the app's
storage, sent once and never shown again. Disconnecting removes it and the
cached appointments.
The app refreshes complete months (previous month through two months ahead,
with time-zone boundary padding) every five minutes in the background, and
within a minute while someone is using the app. It checks the live event version
again before a confirmed write. Recurring events and invitations are readable;
edit those in Apple Calendar initially. New appointments default to a
configurable 30-minute reminder in the preview; existing alarms are preserved
unless explicitly changed. Both native calendar alerts and the app's matching
relative reminders are retained.

### Validation

`npm test` runs the Node suite (the application on Node's SQLite through the
same storage interface) and the Workers suite in workerd: the real Worker with
and without a Cloudflare Access identity, assets, Durable Object restart,
alarm-driven Web Push with keys the app made, and CalDAV discovery and parsing
with mocked HTTP. `npm run check` typechecks and builds the deployment bundle.
Install the repository-local browsers once with `npm run test:ui:install`, then
run `npm run test:ui` for the design-system/browser checks against fixture API
responses, and `npm run test:browser` for preview recovery against the built UI
and the real API handler, as a development server, with a synthetic calendar. No suite loads
`cloudflare/.dev.vars` values or calls live providers. Browser binaries, reports,
and test data stay in `.cache/`. GitHub Actions runs these checks on pull
requests and `main`, without secrets; on `main` a deploy follows.

The household database records its schema version and applies ordered
migrations at startup; a database written by a newer app version is refused.
`GET /api/health` reports readiness without signing in. If Pi storage fails, the
Durable Object restarts and resumes pending assistant work from committed state.

## Confirmed requirements

- Build on Pi Durable and run the assistant on user-controlled infrastructure.
- Work from the phone: changes arrive as pull requests from Claude Code, are
  merged in the GitHub app, and deploy automatically from `main` (decided 19
  October 2026). Running on the Mac is optional, for development and testing,
  never long-term hosting.
- Deploy to Cloudflare. Run the same Worker + Durable Object application locally
  through Wrangler and in deployment; do not maintain a second host or feature
  implementation.
- Start fresh: no existing household data is imported.
- Support iPhones for both spouses and a laptop web interface.
- Start with an iPhone-focused SPA, installable as a web app. Native iOS comes later.
- Permit access away from home through the deployed Cloudflare HTTPS app.
- Sign in through Cloudflare Access in front of the deployment, with no
  passwords or sessions in the app; development needs no sign-in (decided 18
  October 2026).
- The app is an assistant for the two of us and speaks of us by name. Our
  names and emails are never in the repository or on GitHub (decided 18
  October 2026).
- Separate admin access from the two people's: the admin page (`/admin`) sits
  behind Cloudflare Access and also needs the `ADMIN_TOKEN` Worker secret.
  There the admin adds the two people and makes the app's settings (the iCloud
  calendar, ChatGPT and its model); the people use the app day to day (decided
  20 October 2026).
- The application is named `assistant`, deployed as the `assistant` Worker
  (decided 19 October 2026). "Household" is only one of its task categories.
- Use text chat, with the iPhone keyboard's dictation for speech input.
- Every change needs explicit confirmation. Decided: a one-tap Confirm card in
  the conversation, replacing the separate review dialog (planned; today's app
  still opens the review dialog).
- Chat is the driver: the app opens into the conversation with no tab bar, and
  tasks, appointments and summaries are the result of the assistant's actions.
- Build features as plugins on Pi's extension model: chat is the core; tasks,
  calendar and the dashboard are the first plugins, and later features are added
  the same way.
- Without the assistant (ChatGPT not connected or unavailable), quick taps on
  cards (complete, snooze, delete) still work; new requests wait for it (planned).
- Reminders and morning/evening summaries arrive as assistant messages in each
  person's own chat, plus a phone notification (planned).
- Let the spouses own and directly edit their shared calendar. The assistant
  helps manage it rather than maintaining a separate calendar of its own.
- Direct calendar edits and conversational edits must affect the same event.
- Share information between spouses. Personal views are for focus and reducing
  clutter, not secrecy or separate confidential spaces.
- Keep work responsibilities out of the other spouse's default view.
- Assign one follow-up owner per task; either spouse can help or complete it.
- Support one-off tasks and scheduled recurring tasks.
- Store tasks in our own application. Fizzy is a fallback if our task solution
  becomes unwieldy, not an initial integration.
- Enter tasks manually initially; existing tasks are in notes, with no external
  task system to import or synchronize.
- Show missed recurring chores through individual occurrences or a visible
  missed-count indicator, preserving the history rather than hiding misses.
- Send task deadline notifications to the person following up.
- Provide morning and evening summaries, defaulting to 08:00 and 18:00.
  Each person can independently enable, disable, and change the time of each summary.
- Support phone notifications for appointments.
- Open directly into a persistent assistant chat for each login, with separate
  histories that converge on shared tasks and events. Shared channels support
  conversations together, with viewing/typing indicators.
- Use iCloud as the initial shared-calendar integration.
- Prefer the user's existing ChatGPT Plus subscription for AI model access;
  validate the supported sign-in route and actual account access during setup.
- Work online initially. Offline use and native iOS are later work.
- Defer task time-blocking; deadlines do not automatically reserve calendar time.
- Defer documentation features and extensive application documentation. Keep this
  README current and document the actual implementation as it stabilizes.

## Product experience

Prioritize the iPhone SPA. The app is the conversation: it opens full screen
into the person's assistant chat with a compact header, grouped message bubbles
(the assistant's replies as plain text), a pill composer at the bottom,
suggestions for an empty chat, and inline change previews. There is no tab bar.
The menu (a sidebar on laptops) lists the views (Today, Tasks, Calendar and
Settings), the assistant and shared channels; the header's calendar button opens
the day's view. Views open over the chat on phones and beside it on laptops.
Mobile drives the design. The interaction pattern takes inspiration from
[Muse’s design](https://introducing.muse.ai/).

- Today: appointments, due tasks, and overdue work relevant to the signed-in user.
- Household: shared agenda and tasks, with filters by category and person.
- Mine: household responsibilities assigned to the user plus their work and
  personal items. Other items remain accessible through filters.
- Categories such as Household, Work, and Personal control default presentation.
- Two individual sign-ins identify who is acting and who receives reminders.
- Each login has its own ready assistant chat; no conversation creation is needed.
  These separate histories reduce clutter rather than enforce secrecy.
- Shared channels sit in the menu on mobile. Messages go to the two humans;
  mention `@assistant` anywhere in a message or enable “Ask Our day” to involve
  the assistant. The composer shows when Our day will reply.
  Existing topics become channels without losing messages.
- Ordinary human channel messages get per-person unread badges only, not phone
  push. Count the other spouse's messages, not one's own or internal model/tool
  entries. Reading while actively viewing a visible channel advances that
  person's read position across devices. Assistant mentions and task/calendar
  change alerts remain separate. Implementation/reconnect coverage is tracked
  in #37; the current app does not yet have channel unread state.
- The calendar opens to the current month, with event dots. Selecting a date
  shows its appointments, including multi-day and all-day spans.
- The bell opens Updates: partner changes, reminders, and summaries. Settings
  contains preferences and notification controls, not a duplicate reminder list.
- A confirmed app/assistant task or event change notifies only the other spouse,
  through Updates and phone push when enabled. Retrying confirmation does not
  repeat the notification. Direct Apple Calendar edits sync without generating
  change alerts, as chosen by the user. Updates link to the affected record.
- Proposed presence indicator: show which person is viewing or typing in a
  thread; expire stale presence after disconnection. Distinguish this from an
  assistant response in progress.

### Design system

Adopt shadcn/ui's **New York** style with Radix primitives and Tailwind v4.
`components.json` records the preset; `src/components/ui/` holds the standard
component source. Shared tokens in `src/styles.css` retain the sage primary,
warm light surfaces, serif headings, and system body font. A dark palette of the
same tokens follows the device's light/dark setting by default; Settings ›
Appearance can fix Light or Dark per device. Every text color pair meets WCAG AA
in both. Use Tailwind's shared
spacing scale, theme radii, and 44px default controls rather than one-off designs.

Tasks, events, notices, and confirmation previews compose standard components.
Reusable tabs, disclosures, and overlays live in `src/components/app-patterns.tsx`.
Forms use native selectors and date/time fields for the phone's own pickers.
Channels use Sheet; informational panels use Drawer on phones. Write forms and
confirmations use Dialog, bottom-aligned on phones with scrollable content, so
reviewing a preview does not discard the draft. Calendar uses shadcn Calendar
with household-timezone dates and event markers, loaded on demand.

Chat follows the message-list, suggestions, composer, and inline-card pattern,
without replacing the existing persistence, presence, queue, or AI integration.
No assistant-ui dependency is needed for the current text-only experience.
Custom styling is limited to domain composition, the leaf identity, responsive
layout, and PWA safe-area/visual-viewport behavior; there is no custom focus trap
or independently drawn switch.

Browser coverage includes Chromium at 320px/390px phone and 1440px laptop widths,
plus WebKit at 390px. It checks loading, empty, error, disabled, and confirmation
states, keyboard/focus behavior, and a simulated reduced keyboard viewport.
Physical iPhone installation, safe areas, keyboard/dictation, and push delivery
still need device verification. Native iOS remains deferred.

## Chat-driven assistant

Decided with the user on 18 October 2026, delivered as stacked pull requests:

1. **Chat-first shell** (built): the conversation is the whole screen, views open
   from the menu or header, and the chat feels native on phones and laptops.
2. **Plugins** (server built; client next): the core keeps identity, people and
   settings, conversations and channels, the change pipeline, notices and push,
   one scheduler and the API router. A plugin (`server/plugin.ts`) brings its own
   Pi extension (the assistant's `read_<feature>` and `prepare_<feature>_change`
   tools and its instructions), the change kinds it owns, its part of the app's
   data, background work and wake-up times, its routes, and whether its planned
   notices still apply. Tasks, Calendar (iCloud sync and appointment reminders)
   and Dashboard (morning and evening summaries) are the first plugins. Next, the
   client renders each plugin's cards and view, with assistant changes in the
   transcript as one-tap Confirm cards.
3. **Proactive messages**: reminders and summaries posted in each person's chat
   with push, with quick taps that work without the assistant.
4. **Glance views**: views become read-mostly; adding and editing go through the
   chat, and the standalone forms are retired.

## Calendar integration

Use one shared iCloud Household calendar for the POC, as chosen by the user.
One Apple Account is its
technical owner and invites the other with editing permission. The household
app connects through CalDAV; Apple Calendar, the assistant's calendar view,
and confirmed conversational changes all operate on those same events.

The app may cache events for display, but iCloud remains authoritative.
Preserve event identity when updating an appointment. Refresh human edits and
deletions, detect conflicting updates, and show pending or failed synchronization.
Do not treat a calendar subscription or exported copy as two-way integration.

If a confirmed calendar write loses its response, checking that preview is
read-only, even after the preview expires. A retained operation receipt can
prove the original write while preserving later human edits. If the receipt is
lost or the resource has since changed/disappeared, the app reports an unknown
result rather than claiming failure or issuing another write. An absent event
satisfies an uncertain deletion, without proving which client deleted it.
Explicit dismissal keeps the operation record and does not undo any remote
change; review the current calendar before preparing a replacement proposal.

On reload or sign-in, Saved changes restores the signed-in person's direct and
assistant-created previews, including expired but unresolved calendar attempts.
The clipboard button reopens the list. Reviewing is not confirmation. Uncertain
results offer read-only checking, a link back to the current calendar, and
explicit dismissal; expiry alone never claims that an attempted write failed.
Completed, cancelled, dismissed, and never-attempted expired previews are omitted.
The authenticated `/api/previews` read model and `/api/state` expose these views,
not the stored mutation payloads or CalDAV resource URLs.

Read/write access to the actual shared calendar must be validated before
committing to the integration. Radicale remains a fallback if iCloud access is
unsuitable or self-hosting the calendar becomes preferable.

## Task behavior

- Separate ownership from category and visibility.
- One completion finishes the task for the household, regardless of who completes it.
- Record who completed a task and when. Recurring history keeps each
  occurrence's outcome, completing person, and completion time; completions
  recorded before completion times were stored keep their person with an
  unknown time. The task editor's History lists them.
- A recurring task cannot be rescheduled so that an occurrence already in its
  history becomes active again; the preview asks for a later due date. An
  elapsed date that was completed stays completed rather than missed.
- Keep unfinished tasks overdue with their original deadline until explicitly
  completed or rescheduled. Do not silently move deadlines.
- Support fixed recurring schedules initially. Recurrence after completion has
  not been explicitly requested.
- Preserve completion history for recurring work; do not overwrite prior history.
- Preserve missed occurrences or show how many times the chore was missed.
  Proposed display: one active card with a "Missed N times" indicator and an
  expandable history of the missed dates. Historical misses remain recorded
  when the current occurrence is completed. Counting boundaries and display
  details can be refined during implementation.
- Morning summary default: 08:00. Evening summary default: 18:00. Each has its
  own enabled flag and editable local time for each person.
- Proposed summary content: morning agenda, due and overdue work; evening
  outstanding work and tomorrow's appointments. Summaries are informational;
  automatic rescheduling is not required.
- Use Asia/Dubai as the proposed initial time zone; keep time zone and reminder
  settings configurable by person.
- Keep both Apple Calendar and assistant appointment alerts, as explicitly chosen
  by the user. Same-appointment alerts from those two sources are intentional.
- Start with simple reminder defaults, chosen for the POC rather than a large
  policy/settings system: no app-level quiet hours initially (phone Focus still
  applies); a 30-minute default appointment reminder, editable in the preview;
  one task deadline alert per stored due date, with missed recurring work followed
  up in summaries rather than a push for every miss. Preserve overdue deadlines
  and occurrence history.
- Selected catch-up policy: retain overdue task reminders in Updates, but push
  only within two hours of the original due time; deliver summaries up to two
  hours late; deliver appointment reminders up to two hours after their trigger
  only while the event has not ended. Partner-change push expires two hours
  after the change. Never emit a backlog of old summary/recurring pushes.
  Each notice stores the push deadline these rules give it; its Updates record
  remains after the deadline passes.
- Task time-blocking is deferred. The user wants room for spontaneity before
  deciding whether activities should reserve explicit time.

## Conversational changes

For each requested change, identify the target and show a concrete preview of
what will change, including assignment, category, and time when relevant.
Wait for explicit confirmation before writing. Ask for missing or ambiguous
details before presenting the preview. Cancelled previews have no effect.

Before applying a confirmed change, check whether its target has changed since
the preview. If the preview is stale, show the updated proposal rather than
silently applying an outdated change. An app editor whose task or appointment
changed or was deleted reloads the current version and keeps the person's
edits, so the next review compares them with the latest saved version. Prevent duplicate writes if confirmation
is retried, and report success only after the authoritative system accepts it.

Read-only questions do not require confirmation. Agreed reminder delivery and
recurring schedules should execute according to their configured rules; they
should not need conversational approval each time they run.

Direct edits mean explicit controls such as tapping Complete or editing a due
date and pressing Save. They also require a confirmation preview, as chosen by
the user. Human edits in Apple Calendar are governed by that application's normal
behavior.

Duplicate appointment alerts would occur if both Apple Calendar and our app
notify the same person about the same appointment at the same reminder time.
Both sources of appointment alerts are intentionally retained. Our app also
sends task alerts and summaries. Repeated delivery of the same app notification
after retries should still be prevented.

## Development and hosting

**Target:** the `assistant` Cloudflare Worker for routing/assets and one
SQLite-backed Durable Object, owning shared records, independent Pi conversations,
and alarm-driven jobs. The same application runs locally through Wrangler on the
Mac, which is for development and testing, not long-term hosting: the local app
stops with its process. Storage goes through Pi's `SqliteDatabase` interface,
so the Node test suite runs the same code on Node's SQLite.

Restrict access to the two users through Cloudflare Access. A public hostname
does not imply public registration or access to household data. Use a stable HTTPS origin for the
installable app's service worker and push features. Enable notifications after
installing on each iPhone Home Screen and obtaining permission. The app keeps its
push keys stable itself. Integrations are connected once per deployment, in the
app; local tests use isolated fixture credentials/data, not implicit copies of
production secrets.

Live iCloud, ChatGPT eligibility/inference, and device acceptance remain pending
user configuration and validation (#24, #36). Hosted ChatGPT eligibility is not
established by choosing Cloudflare; keep AI optional/disabled when unavailable,
with no API-key billing fallback. Run one deployment per household; a local
`npm run dev` keeps its own separate data.

## AI access

The chosen direction is to use the user's existing OpenAI/ChatGPT subscription,
not a locally hosted model. Pi Durable accepts the Models collection from
`@earendil-works/pi-ai`; the current pi-ai documentation explicitly supports
OpenAI OAuth via Sign in with ChatGPT for subscription-backed requests.

OpenAI also documents ChatGPT-plan access for locally hosted/open-source apps
using authorized OAuth access to eligible Responses API requests. Library
support is verified from current documentation; successful sign-in, the selected
model, and an actual request for this user's account are not yet verified.
Use the supported sign-in flow rather than copying Codex's stored credentials.
Do not silently fall back to separately billed API-key requests.

The user has ChatGPT Plus and is willing to consider Pro if usage requires it.
The desired experience is an owner-configured AI connection with no provider
setup required of the other person. The official documentation reviewed confirms
eligible per-user plan usage, but does not establish that one Plus subscription
can fund both spouses' interactive use. Keep this eligibility question explicit;
neither library support nor a Pro upgrade alone resolves it. Keep application
sign-in distinct from the account authorizing model usage.

The admin connects ChatGPT on the admin page with Sign in with ChatGPT, the
flow pi-ai uses (a public client with PKCE and OpenAI's dynamic client
registration), run by the app: "Connect ChatGPT" opens OpenAI's sign-in, which
ends on `http://127.0.0.1:1455/auth/callback`, an address only an app on the
same device answers. The browser shows an error page there; the admin copies
its address back into the admin page, and the app exchanges the code for
tokens. The verifier and state never leave the app, so a pasted address
finishes only the sign-in the admin started, once, within ten minutes. Then
the admin chooses the model from the account's catalog; the choice applies at
once. The app keeps the connection and its refreshed tokens in its own storage,
never shows or logs tokens, never reads Codex's tokens, and never falls back to
an API key. "Disconnect ChatGPT" removes the connection; revoke the app in
ChatGPT settings if desired. Whether
OpenAI treats a Cloudflare deployment as an eligible installation is not yet
established.

The first connected session explains plan usage; the composer links to ChatGPT
usage settings. Both household accounts use the household connection. This wires
the requested experience but does not establish shared-plan eligibility or
verify this account's access. Each chat runs one assistant request at a time and accepts up to ten queued
messages while it works. Queued requests retain their authors and survive restarts.
Pi persists the input, model/tool turns, and outstanding work; startup resumes
pending inputs with the same request ID. Model calls are capped at eight per
request, with a 90-second timeout per call and no automatic provider retries.
Pi compaction summaries serve a whole topic rather than one request, so they
are metered separately: at most six per topic per rolling day. Other model
entry points are refused so no inference goes unmetered.
Assistant tools can read household data or prepare a preview, never confirm it.
The requesting spouse must use the app dialog; a reply of “yes” cannot apply a
change. Cancelled and expired proposals cannot apply changes. A failed request
keeps its message and any surviving proposals visible for review. While AI
is unavailable, unfinished requests stay paused and new assistant requests in
that conversation are refused, but ordinary messages are still saved; the
paused request resumes once after reconnecting. If the ChatGPT settings cannot be
read, the app starts without the assistant.

Verified against [OpenAI's local-app flow](https://developers.openai.com/siwc/token-sharing-open-source)
and [model/inference requirements](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

## POC acceptance scenarios to refine

1. A chat-created task appears with the confirmed owner, category, and due date.
2. A cancelled task or appointment preview writes nothing.
3. A confirmed appointment appears in the shared calendar for both spouses.
4. A human reschedules that appointment; the assistant reflects the same event.
5. An assistant reschedules it after confirmation without creating a duplicate.
6. Either spouse completes a household task; it leaves both active views.
7. Work tasks remain accessible but do not clutter the other spouse's default view.
8. A task owner receives a deadline notification and enabled morning/evening summaries.
9. Recurring chores preserve history and follow the agreed missed-occurrence policy.
10. The installed phone app works away from home at the stable Cloudflare HTTPS origin.
11. Restarting/recreating the household runtime preserves tasks, conversations,
    pending state, and scheduled wakeups (also tested locally on the Mac).
12. Summary times and toggles are independent for each person and each summary.
13. Shared channels display current human interaction and clear stale indicators.
14. Missed chores remain visible as occurrences or an accurate missed-count history.

## Outstanding decisions

- Eligibility of the desired shared Plus-funded AI connection, and account/model
  validation through Pi's supported sign-in flow.
- Stable Cloudflare app hostname and production integration configuration.
- Undo and handling batch changes; all task/calendar edits require a preview.
- Revisit reminder defaults only after POC use; keep the selected initial policy simple.
- Calendar recurrence edits: one occurrence versus an entire series.
- Detailed missed-occurrence counting and presentation.

Native iOS, offline operation, task time-blocking, and documentation features are
deferred rather than prerequisites for the initial build.

## Working in this repository

This README is the evolving specification. Keep confirmed requirements,
recommendations, and outstanding decisions distinct as the design develops.
Implementation will follow the agreed POC scope, with further decisions captured
as they arise during development.

Changes are delivered through pull requests for the user to review and merge
into `main`. See [AGENTS.md](AGENTS.md) for repository workflow instructions.

The [17 October 2026 review](docs/reviews/2026-10-17/README.md) records implementation
findings, Pi Durable architecture recommendations, and reproduction evidence at
commit `c85e65a`. Its recommendations remain proposals; this README continues to
define confirmed requirements. Cloudflare was subsequently selected as the
deployment target, and the Node host was replaced by the single Cloudflare
application described above.

## References

- Pi Durable: https://github.com/earendil-works/pi/blob/main/packages/durable/README.md
- Pi model library and OAuth: https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#oauth-providers
- ChatGPT plan usage: https://developers.openai.com/siwc/token-sharing-open-source
- ChatGPT plan inference: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- iCloud calendar sharing: https://support.apple.com/en-ca/guide/iphone/iph7613c4fb/ios
- Third-party iCloud access: https://support.apple.com/en-il/121539
- CalDAV client documentation: https://tsdav.vercel.app/intro/
- iPhone Home Screen web push: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- HTTPS and service workers: https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers
- Cloudflare Durable Objects: https://developers.cloudflare.com/durable-objects/
- Wrangler: https://developers.cloudflare.com/workers/wrangler/
- Fizzy: https://www.fizzy.do/
- Fizzy API: https://github.com/basecamp/fizzy/blob/main/docs/api/README.md

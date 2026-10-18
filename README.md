# Household assistant

Updated: 2026-10-18. Status: initial POC scope agreed; implementation and
remaining interaction decisions will evolve through pull requests.

## Purpose

A personal assistant for two spouses, starting with a calendar and tasks and
potentially expanding to documentation later. It is for their own use, with no public
registration or product offering. The primary goal is to make appointments and
unfinished responsibilities easy to capture, see, and follow up on.

## Current build

The first foundation includes two household accounts, shared tasks with
confirmation previews, daily/weekly chores with missed-date history, per-person
summary settings, and topic messages persisted through Pi Durable. An iCloud
agenda supports confirmed appointment creation, edits, and deletion against the
original records. The assistant can read household information and prepare the
same confirmation previews from chat. Phone push, a real iCloud round trip, and
completed ChatGPT inference still require local account/device verification.

Use Node.js 24 or newer. All project data, caches, and scripts stay in this repo.

```sh
npm ci --cache ./.cache/npm --ignore-scripts
npm run configure
npm run dev
```

Open `http://localhost:5173`. The local `.env` file contains the generated
`owner` and `partner` passwords; edit names there before the first start.
Existing accounts are preserved in `data/`. For a built app, use `npm run build`
and `npm start`, set `APP_ORIGIN` to its actual address, and route Cloudflare
Tunnel to the local server on port 3000. Use a stable HTTPS hostname for phones.
Set `PUSH_CONTACT` to a real `mailto:` address or use the HTTPS app origin for
phone notifications. With no push setup, reminders remain available in the app.

To connect the calendar, create/share the iCloud `Household` calendar and set
`ICLOUD_USERNAME`, `ICLOUD_APP_PASSWORD` (an Apple app-specific password), and
`ICLOUD_CALENDAR_NAME` in the local `.env`. Restart the server. If names are
ambiguous, set `ICLOUD_CALENDAR_URL` to the exact calendar URL instead. Credentials
stay on the server; neither spouse needs to enter them for everyday app use.
The app refreshes complete months (previous month through two months ahead,
with time-zone boundary padding) every minute
and checks the live event version again before a confirmed write. Recurring
events and invitations are readable; edit those in Apple Calendar initially.
New appointments default to a configurable 30-minute reminder in the preview;
existing alarms are preserved unless explicitly changed. Both native calendar
alerts and the app's matching relative reminders are retained.

Validation commands: `npm test` and `npm run build`. Install the repository-local
browsers once with `npm run test:ui:install`, then run `npm run test:ui` for
the design-system/browser checks against fixture API responses. Run
`npm run test:browser` for preview recovery against the built UI and an isolated
Express/SQLite/Pi test server with a synthetic calendar. Neither suite loads
production credentials or calls live providers. Browser binaries, reports,
screenshots, temporary profiles, and test data stay in `.cache/`; household data
and push keys stay in `data/`.

## Cloudflare compatibility prototype

A separate Cloudflare prototype now evaluates Workers and one SQLite-backed
Durable Object as a hosting option. It has two sign-ins, a shared persistent Pi
conversation, durable test reminders, and optional read-only iCloud and phone
push probes. It uses fixture replies by default, without calling an AI provider.
The existing Mac application and its data remain separate; a full cloud migration
is still proposed rather than implemented.

```sh
npm run cloudflare:configure
npm run cloudflare:dev
```

Open `http://localhost:8787` and use the generated `owner` or `partner` password
in `cloudflare/.dev.vars`. Local runtime state lives in `data/cloudflare/`.
`npm test` includes the Cloudflare runtime tests; `npm run cloudflare:check`
checks types and builds a deployment bundle without uploading it.
See [Cloudflare setup and deployment](cloudflare/README.md) for secrets, live
integration checks, recovery behavior, and remaining migration work. No cloud
account deployment or real-device delivery is implied by local test results.

## Confirmed requirements

- Build on Pi Durable and run the assistant on user-controlled infrastructure.
- Develop and run the initial POC on the user's Mac.
- Keep the home Linux PC as a hosting option once the application is stable.
- Support iPhones for both spouses and a laptop web interface.
- Start with an iPhone-focused SPA, installable as a web app. Native iOS comes later.
- Permit access away from home through Cloudflare Tunnel.
- Use text chat, with the iPhone keyboard's dictation for speech input.
- Show a preview and require confirmation before changes from either chat or
  direct task/calendar controls.
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
- Send task deadline notifications to the owner.
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

Prioritize the iPhone SPA. The opening screen is a continuous assistant chat,
with a compact activity header, a bottom composer, suggestions for an empty
chat, and inline change previews. The laptop keeps the same experience with
wider content and a visible channel rail; mobile drives the design. The interaction pattern takes inspiration from
[Muse’s design](https://introducing.muse.ai/).

- Today: appointments, due tasks, and overdue work relevant to the signed-in user.
- Household: shared agenda and tasks, with filters by category and person.
- Mine: household responsibilities assigned to the user plus their work and
  personal items. Other items remain accessible through filters.
- Categories such as Household, Work, and Personal control default presentation.
- Two individual sign-ins identify who is acting and who receives reminders.
- Each login has its own ready assistant chat; no conversation creation is needed.
  These separate histories reduce clutter rather than enforce secrecy.
- Shared channels sit in a drawer on mobile. Messages go to the two humans;
  mention `@assistant` or enable “Ask Our day” to involve the assistant.
  Existing topics become channels without losing messages.
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
warm light surfaces, serif headings, and system body font. Use Tailwind's shared
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
still need device verification. Native iOS remains deferred. The isolated
Cloudflare probe client is unchanged; it is not the React product frontend.

## Calendar integration

Use one shared iCloud Household calendar for the POC, as chosen by the user.
One Apple Account is its
technical owner and invites the other with editing permission. The assistant
server connects through CalDAV; Apple Calendar, the assistant's calendar view,
and confirmed conversational changes all operate on those same events.

The server may cache events for display, but iCloud remains authoritative.
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
- Record who completed a task and when.
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
- Quiet hours, appointment reminder timing, and reminder catch-up after a restart
  remain to be settled.
- Task time-blocking is deferred. The user wants room for spontaneity before
  deciding whether activities should reserve explicit time.

## Conversational changes

For each requested change, identify the target and show a concrete preview of
what will change, including assignment, category, and time when relevant.
Wait for explicit confirmation before writing. Ask for missing or ambiguous
details before presenting the preview. Cancelled previews have no effect.

Before applying a confirmed change, check whether its target has changed since
the preview. If the preview is stale, show the updated proposal rather than
silently applying an outdated change. Prevent duplicate writes if confirmation
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

During development, run the app, Pi Durable harness, persistence, and reminder
scheduling on the Mac, where the user is working with Codex.
Use Cloudflare Tunnel with a stable HTTPS hostname for phone and laptop access.
Restrict application access to the two users. A public hostname does not imply
public registration or access to household data.

Use HTTPS for the installable app's service worker and push features. Enable
notifications after installing the app on the iPhone Home Screen and obtaining
notification permission. The stable origin should survive Mac/app restarts.

The Mac and relevant processes must remain awake, running, and connected to
serve the app and send reminders on time. Specify restart recovery and how to
handle missed reminder jobs; do not promise uninterrupted delivery from a
sleeping Mac. Once the app is stable, the user's home Linux PC is a hosting
option. A dedicated server or Cloudflare compute services are also future
options. Keep that decision open during development; using a tunnel does not
move the server off the Mac.

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
setup required of the wife. The official documentation reviewed confirms
eligible per-user plan usage, but does not establish that one Plus subscription
can fund both spouses' interactive use. Keep this eligibility question explicit;
neither library support nor a Pro upgrade alone resolves it. Keep application
sign-in distinct from the account authorizing model usage.

Run `npm run ai:connect` in a terminal on the Mac to authorize this installation
with Sign in with ChatGPT and choose a model from the account's catalog. Restart
the app afterward. Tokens and the stable host ID stay under the ignored
`DATA_DIR` with restricted file permissions; the app never reads Codex's tokens
or falls back to an API key. `npm run ai:disconnect` removes the local credential;
restart the service and revoke the app in ChatGPT settings if desired. If a
crash leaves `chatgpt-auth.json.lock`, stop all app/setup processes before
inspecting and removing that directory; locks are never stolen automatically.

The first connected session explains plan usage; the composer links to ChatGPT
usage settings. Both household accounts use the server connection. This wires
the requested experience but does not establish shared-plan eligibility or
verify this account's access. Each chat runs one assistant request at a time and accepts up to ten queued
messages while it works. Queued requests retain their authors and survive restarts.
Pi persists the input, model/tool turns, and outstanding work; startup resumes
pending inputs with the same request ID. Model calls are capped at eight per
request, with a 90-second timeout per call and no automatic provider retries.
Assistant tools can read household data or prepare a preview, never confirm it.
The requesting spouse must use the app dialog; a reply of “yes” cannot apply a
change. Cancelled and expired proposals cannot apply changes. A failed request
keeps its message and any surviving proposals visible for review.

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
10. The installed phone app works away from home through the tunnel.
11. Restarting the Mac service preserves tasks, conversations, and pending state.
12. Summary times and toggles are independent for each person and each summary.
13. Shared channels display current human interaction and clear stale indicators.
14. Missed chores remain visible as occurrences or an accurate missed-count history.

## Outstanding decisions

- Eligibility of the desired shared Plus-funded AI connection, and account/model
  validation through Pi's supported sign-in flow.
- Sign-in method for the two users and any existing Cloudflare domain/setup.
- Undo and handling batch changes; all task/calendar edits require a preview.
- Appointment alert timing, quiet hours, summary content, and restart catch-up.
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
define confirmed requirements, and hosting remains undecided.

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
- Cloudflare Tunnel: https://developers.cloudflare.com/tunnel/get-started/
- Fizzy: https://www.fizzy.do/
- Fizzy API: https://github.com/basecamp/fizzy/blob/main/docs/api/README.md

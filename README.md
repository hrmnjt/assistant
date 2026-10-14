# Household assistant

Updated: 2026-10-14. Status: initial POC scope agreed; implementation and
remaining interaction decisions will evolve through pull requests.

## Purpose

A personal assistant for two spouses, starting with a calendar and tasks and
potentially expanding to documentation later. It is for their own use, with no public
registration or product offering. The primary goal is to make appointments and
unfinished responsibilities easy to capture, see, and follow up on.

## Confirmed requirements

- Build on Pi Durable and run the assistant on user-controlled infrastructure.
- Develop and run the initial POC on the user's Mac.
- Keep the home Linux PC as a hosting option once the application is stable.
- Support iPhones for both spouses and a laptop web interface.
- Start with an iPhone-focused SPA, installable as a web app. Native iOS comes later.
- Permit access away from home through Cloudflare Tunnel.
- Use text chat, with the iPhone keyboard's dictation for speech input.
- Show a preview and require confirmation before every assistant-initiated change.
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
- Use separate topic threads, with an icon indicating when someone is interacting
  with a thread.
- Use iCloud as the initial shared-calendar integration.
- Prefer the user's existing OpenAI/ChatGPT subscription for AI model access;
  validate the supported sign-in route and actual account access during setup.
- Work online initially. Offline use and native iOS are later work.
- Defer task time-blocking; deadlines do not automatically reserve calendar time.
- Defer documentation features and extensive application documentation. Keep this
  README current and document the actual implementation as it stabilizes.

## Product experience

The SPA, in-app tasks, and topic threads are agreed. The following view layout
and interaction details remain proposals unless explicitly stated otherwise.

- Today: appointments, due tasks, and overdue work relevant to the signed-in user.
- Household: shared agenda and tasks, with filters by category and person.
- Mine: household responsibilities assigned to the user plus their work and
  personal items. Other items remain accessible through filters.
- Categories such as Household, Work, and Personal control default presentation.
- Two individual sign-ins identify who is acting and who receives reminders.
- Chat is accessible alongside calendar and task views, with links from responses
  to the affected records.
- Shared topic threads can cover household, work, and personal discussions.
  Work categories and filters reduce clutter without making content secret.
- Proposed presence indicator: show which person is viewing or typing in a
  thread; expire stale presence after disconnection. Distinguish this from an
  assistant response in progress.

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
- Quiet hours, appointment reminder timing, reminder catch-up after a restart,
  and the sender of appointment notifications remain to be settled.
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
date and pressing Save. Whether those need a second confirmation preview remains
open. The current proposal is immediate direct edits with undo where practical;
assistant-initiated changes always need a preview and confirmation. Human edits
in Apple Calendar are governed by that application's normal behavior.

Duplicate appointment alerts would occur if both Apple Calendar and our app
notify the same person about the same appointment at the same reminder time.
The proposed default is Apple Calendar for appointment alerts and our app for
task alerts and summaries. This is pending the user's preference. Repeated
delivery of the same app notification after retries should always be prevented.

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

Clarify the subscription plan and how each spouse's AI identity is authorized;
shared household data does not establish shared subscription entitlement.
Keep application sign-in distinct from the account authorizing model usage.

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
13. Topic threads display current human interaction and clear stale indicators.
14. Missed chores remain visible as occurrences or an accurate missed-count history.

## Outstanding decisions

- OpenAI subscription plan, authorized AI identity for each spouse, and account/model
  validation through Pi's supported sign-in flow.
- Sign-in method for the two users and any existing Cloudflare domain/setup.
- Direct-interface confirmation behavior, undo, and handling batch changes.
- Appointment alert sender/timing, quiet hours, summary content, and restart catch-up.
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

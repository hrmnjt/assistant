# Household assistant

Updated: 2026-10-14. Status: discovery draft, not authorization to build.

## Purpose

A personal assistant for two spouses, starting with a calendar and tasks and
later expanding to documentation. It is for their own use, with no public
registration or product offering. The primary goal is to make appointments and
unfinished responsibilities easy to capture, see, and follow up on.

## Confirmed requirements

- Build on Pi Durable and run the assistant on user-controlled infrastructure.
- Develop and run the initial POC on the user's Mac.
- Keep the home Linux PC as a hosting option once the application is stable.
- Support iPhones for both spouses and a laptop web interface.
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
- Send task deadline notifications and a daily overdue summary to the owner.
- Support phone notifications for appointments.
- Refine and review the specification before starting implementation.

## Proposed product experience

These recommendations are not yet final decisions.

- One installable web app for iPhone and laptop, rather than a native iOS app
  for the POC.
- Today: appointments, due tasks, and overdue work relevant to the signed-in user.
- Household: shared agenda and tasks, with filters by category and person.
- Mine: household responsibilities assigned to the user plus their work and
  personal items. Other items remain accessible through filters.
- Categories such as Household, Work, and Personal control default presentation.
- Two individual sign-ins identify who is acting and who receives reminders.
- Chat is accessible alongside calendar and task views, with links from responses
  to the affected records.
- In-app tasks are the current recommendation. Fizzy remains a candidate if
  using its own board interface is part of the desired daily experience.
- No requirement for secrecy between spouses. The conversation layout and
  default visibility of work conversations still need to be settled.

## Calendar recommendation

Use one shared iCloud Household calendar for the POC. One Apple Account is its
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
- Missed recurring occurrences need an explicit policy before implementation.
- Daily overdue summaries are informational; automatic rescheduling is not required.
- Digest time, time zone, quiet hours, appointment reminder defaults, and any
  duplicate notifications from Apple Calendar are unresolved settings.
- Do not turn every task deadline into an appointment automatically. Whether
  tasks can be explicitly scheduled as calendar time blocks remains open.

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

Whether direct edits in our own task/calendar interface also need a separate
confirmation preview remains open. Human edits in Apple Calendar are governed
by that application's normal behavior.

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

The AI model provider and whether the model runs locally or in the cloud are
still unresolved. Do not infer the model location from the server location.

## POC acceptance scenarios to refine

1. A chat-created task appears with the confirmed owner, category, and due date.
2. A cancelled task or appointment preview writes nothing.
3. A confirmed appointment appears in the shared calendar for both spouses.
4. A human reschedules that appointment; the assistant reflects the same event.
5. An assistant reschedules it after confirmation without creating a duplicate.
6. Either spouse completes a household task; it leaves both active views.
7. Work tasks remain accessible but do not clutter the other spouse's default view.
8. A task owner receives a deadline notification and an overdue daily summary.
9. Recurring chores preserve history and follow the agreed missed-occurrence policy.
10. The installed phone app works away from home through the tunnel.
11. Restarting the Mac service preserves tasks, conversations, and pending state.

## Outstanding decisions

- Cloud AI provider or local model; provider preference and credentials.
- Missed recurring-task policy: consolidate, retain every occurrence, or mark missed.
- Task backend and whether Fizzy's own interface is required.
- Conversation layout and filters for work versus household discussions.
- Sign-in method for the two users and any existing Cloudflare domain/setup.
- Direct-interface confirmation behavior, undo, and handling batch changes.
- Reminder defaults, digest timing/time zone, and restart catch-up behavior.
- Calendar recurrence edits: one occurrence versus an entire series.
- Offline needs and whether tasks should support scheduled calendar time blocks.
- What documentation should mean in the later phase.

## Working in this repository

This README is the evolving specification. Keep confirmed requirements,
recommendations, and outstanding decisions distinct as the design develops.
Application implementation has not started.

Changes are delivered through pull requests for the user to review and merge
into `main`. See [AGENTS.md](AGENTS.md) for repository workflow instructions.

## References

- Pi Durable: https://github.com/earendil-works/pi/blob/main/packages/durable/README.md
- iCloud calendar sharing: https://support.apple.com/en-ca/guide/iphone/iph7613c4fb/ios
- Third-party iCloud access: https://support.apple.com/en-il/121539
- CalDAV client documentation: https://tsdav.vercel.app/intro/
- iPhone Home Screen web push: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- HTTPS and service workers: https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers
- Cloudflare Tunnel: https://developers.cloudflare.com/tunnel/get-started/
- Fizzy: https://www.fizzy.do/
- Fizzy API: https://github.com/basecamp/fizzy/blob/main/docs/api/README.md

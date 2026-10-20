# Cloudflare runtime

`worker.ts` is the only host for the assistant. The Worker serves the built
client from `dist/` (single-page fallback, headers from `public/_headers`) and
sends `/api/*` to one SQLite-backed Durable Object named `household`. There are
no caller-chosen object names and no public registration. Setup, deployment and
settings are in the [README](../README.md#how-we-work).

## Files

- `wrangler.jsonc`: Worker name, assets, the `HOUSEHOLD` binding and its SQLite
  class migration. Keep the class, binding and migration history on later
  deploys so they keep addressing the same storage.
- [.dev.vars.example](.dev.vars.example): every Worker variable and secret.
  A deployment's are set on the Worker's Settings → Variables and Secrets;
  `npm run dev` reads them from `.dev.vars`. `npm run ai:connect -- --production`
  writes the ChatGPT connection to `.prod.vars`, which `npm run secrets`
  uploads. Git ignores both files. The app keeps only push keys and each
  person's reminder settings in its own storage.
- `tests/`: workerd tests of the real Worker; `vitest.config.ts` blanks every
  documented setting, so a developer's `.dev.vars` never reaches them, then
  names two test people. The
  tests call the Worker as Cloudflare does, with or without an Access identity
  on the request context.

The runner `scripts/cloudflare.mjs` keeps Wrangler's configuration, login,
logs, temporary bundles and test caches under `.cache/cloudflare/`, and local
state under `data/cloudflare/`.

## Storage and scheduling

The household tables and Pi's conversation tables share the object's SQLite
database through one serialized `DurableObjectSqliteDatabase` queue, so a
household transaction and a Pi transaction never interleave. Household tables
avoid Pi's unprefixed names (tasks live in `household_tasks`). Alarm writes go
through the same queue, so an open transaction cannot roll them back.

One alarm drives all background work. Each run arms a recovery wakeup a minute
ahead, runs each plugin's background work in order (the calendar refreshes every
five minutes and plans appointment reminders, tasks plan deadline notices, the
dashboard plans summaries), delivers notices, waits up to 25 seconds for
unfinished assistant work, then sets the alarm for the earliest time the core
or any plugin reports. A write request also brings the alarm forward
when it creates earlier work, and a read refreshes a calendar older than a
minute. Pending assistant work resumes on the next wakeup after an eviction.

If configuration is missing or invalid, the API answers 503 with a message
naming the setting; other startup errors are not exposed. Only
`npm run dev` sets `HOUSEHOLD_DEVELOPMENT` (no sign-in, loopback addresses
only); a deployment needs the identity Cloudflare Access gives each request.
The Worker removes any identity header a client sends before setting its own. If Pi storage fails,
the object restarts and reopens from committed state.

## Delivery semantics

Confirmations, partner notices and request receipts commit in one transaction,
and retries reuse the same IDs, so a retried confirmation does not duplicate a
task or a notice. Web Push records each device's success, retries transient
failures until the notice's push deadline, and removes subscriptions the push
service reports as gone (404/410). A crash after the push service accepts a
request but before the success is recorded can repeat that push; the
notification tag stays the same. These are retry-safe records, not
exactly-once external delivery.

## Not yet verified

The workerd tests mock CalDAV and push HTTP. A real iCloud round trip, delivery
to installed iPhones, and ChatGPT sign-in and inference from a deployment still
need checking with the user's accounts and devices. There is no export, backup
or restore command yet.

# assistant

A private chat with ChatGPT, shared by a few people. It runs as one Cloudflare
Worker behind Cloudflare Access and answers using the owner's ChatGPT plan,
connected with Sign in with ChatGPT.

- `/` is the chat. Each thread keeps its own context; **Chats** lists them,
  newest first, and **New** starts one. Replies stream in, with the model's
  reasoning summary above them. Under the message box are the chat's model and
  reasoning effort, which each chat can change from the defaults for everyone
  in it. Every open page keeps up: a message sent on one device shows, with its
  reply streaming, on the others.
- Everyone sees the same threads, and each message shows its sender's letter.
  A message sent while a thread is replying waits below the reply, then goes
  in and gets its own reply, in the order sent.
- `/admin` connects ChatGPT, chooses the default model and reasoning effort
  (medium until chosen), and gives each person their letter.

## How it works

`public/` holds the pages: plain HTML, CSS and JavaScript, with no build step.
They use [Basecoat](https://basecoatui.com) (shadcn/ui's components as plain
HTML classes), kept in `public/vendor/`; `public/style.css` adds only the
chat's own layout.
Cloudflare serves them as static files; only `/api/*` reaches the Worker.
`src/worker.ts` checks that each request came through Cloudflare Access and
passes it, with the email Access signed the person in with, to the `Chat`
Durable Object (`src/chat.ts`). It keeps the threads (each with its own model
and reasoning effort, if it chose them), their messages and the messages
waiting for a reply, the people and their letters, the ChatGPT sign-in, and the
default model and reasoning effort.
Each open chat page holds a WebSocket to it (`/api/events`), which says when a
thread changes; the page then fetches that thread again. A page that comes back
to the foreground, or reconnects, fetches again too, in case it missed a change.
`src/chatgpt.ts` talks to OpenAI. The model sees the last 50 messages of the
thread it is answering, each person's starting with their letter. It is told
who shares the chat, and asked to keep track of who said what and to help
people who see something differently find a view they can share.

## Setup

1. Protect the Worker with Cloudflare Access: in the Worker's Settings →
   Domains & Routes, enable Access for its workers.dev address, and let only
   your emails through in the Access policy.
2. In the Worker's Settings → Variables and Secrets, add two text variables.
   Until both are set, the app refuses every request.
   - `ACCESS_TEAM_DOMAIN`: your team domain,
     `https://<team>.cloudflareaccess.com` (Zero Trust → Settings).
   - `ACCESS_AUD`: the Application Audience (AUD) tag of the Worker's Access
     application (Zero Trust → Access → Applications).
3. Open `/admin` and connect ChatGPT. OpenAI's sign-in ends on an
   `http://127.0.0.1:1455` address that doesn't load: copy it into the page.
   Then choose the model, and give each person a letter.

## Deploy

Cloudflare Workers Builds deploys each push to `main` (build command
`npm ci --cache ./.cache/npm --ignore-scripts`, deploy command
`npm run deploy`). GitHub Actions runs `npm run check` (typecheck and Worker
bundle) on pull requests.

## Run locally (optional)

```sh
npm ci
npm run dev
```

Then open http://localhost:8787. There is no Access check locally: you are the
email an `as` cookie names (`document.cookie = 'as=you@example.com'`), if any.

## Not yet

Markdown in replies, and tools such as a calendar. The earlier, larger version
of this app is on the `archive/v1` branch.

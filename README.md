# assistant

A private chat with ChatGPT, for one person for now. It runs as one Cloudflare
Worker behind Cloudflare Access and answers using the owner's ChatGPT plan,
connected with Sign in with ChatGPT.

- `/` is the chat. Each thread keeps its own context; **Chats** lists them,
  newest first, and **New** starts one. Replies stream in, with the model's
  reasoning summary above them.
- `/admin` connects ChatGPT and chooses the model.

## How it works

`public/` holds the pages: plain HTML, CSS and JavaScript, with no build step.
Cloudflare serves them as static files; only `/api/*` reaches the Worker.
`src/worker.ts` checks that each request came through Cloudflare Access and
passes it to the `Chat` Durable Object (`src/chat.ts`), which keeps the
threads and their messages, the ChatGPT sign-in and the chosen model.
`src/chatgpt.ts` talks to OpenAI. The model sees the last 50 messages of the
thread it is answering.

## Setup

1. Protect the Worker with Cloudflare Access: in the Worker's Settings →
   Domains & Routes, enable Access for its workers.dev address, and let only
   your email through in the Access policy.
2. In the Worker's Settings → Variables and Secrets, add two text variables.
   Until both are set, the app refuses every request.
   - `ACCESS_TEAM_DOMAIN`: your team domain,
     `https://<team>.cloudflareaccess.com` (Zero Trust → Settings).
   - `ACCESS_AUD`: the Application Audience (AUD) tag of the Worker's Access
     application (Zero Trust → Access → Applications).
3. Open `/admin` and connect ChatGPT. OpenAI's sign-in ends on an
   `http://127.0.0.1:1455` address that doesn't load: copy it into the page.
   Then choose the model.

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

Then open http://localhost:8787. There is no Access check locally.

## Not yet

A second person sharing the threads, Markdown in replies, and tools such as a
calendar. The earlier, larger version of this app is on the `archive/v1`
branch.

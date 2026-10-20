# Working in this repository

A small private chat with ChatGPT: one Cloudflare Worker (`assistant`) with one
Durable Object, and plain HTML/JS pages in `public/`. Keep it that small.

- Build only what is asked: no speculative features, abstractions, tests,
  scripts or docs. Propose larger changes before making them.
- The owner works from a phone. Deliver changes as pull requests; the owner
  merges them with "Rebase and merge", so keep branches linear. Merging to
  `main` deploys.
- Commits are the owner's alone: author them as the owner, with no Claude
  co-author or session lines and no session signing key
  (`git -c commit.gpgsign=false`).
- `npm run check` (typecheck and Worker bundle) must pass. Try behavior changes
  with `npm run dev`.
- Treat the repository as public: never commit names, emails, account
  identifiers, deployment addresses or secrets. Settings belong in the
  Worker's variables and secrets.
- Keep README.md short and true to the code.

## Where things stand

Rewrite this section in each pull request so it stays true; don't append to
it. History is in `git log`, the merged pull requests and the `archive/v1`
branch.

- Live: a one-person chat and `/admin`. Verified on the owner's phone in
  October 2026: ChatGPT replies through the owner's plan, streaming, and
  reasoning summaries.
- Outside the repo: Cloudflare Access on the workers.dev address, the Worker
  variables `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, and ChatGPT connected on
  `/admin`.
- Why it's this way: an earlier app grew to 12,000 lines before its first
  working reply, so this one grows a step at a time. The Worker calls
  OpenAI's Responses API directly (pi-ai and Pi Durable were dropped as too
  heavy for Workers); there is no admin password while there is one person;
  the pages are plain JS with no build step.
- Next, as the owner sees it: threads, so conversations don't share context,
  then multiplayer with a second person. Other ideas: a reasoning level on
  `/admin`, bold reasoning-summary headings, a narrower chat on desktop.

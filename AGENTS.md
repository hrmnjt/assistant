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
- Build the pages from Basecoat's stock components (`public/vendor/`, docs at
  basecoatui.com) and its theme colors. Add to `public/style.css` only what
  Basecoat doesn't cover, such as the chat's layout.

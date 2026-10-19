# Repository instructions

## Product specification

- Treat README.md as the working product specification and keep it up to date
  with decisions made with the user.
- Distinguish confirmed requirements from proposals and open questions.
- The user has selected the initial POC scope and asked to proceed with the
  initial build. Follow the agreed scope in README.md, clarify unresolved
  behavior when it matters, and capture decisions as implementation evolves.
- Keep documentation concise and grounded in the implementation. Native iOS,
  offline use, task time-blocking, and documentation features are deferred.
- Cloudflare is the deployment target: one Worker (`assistant`) and one Durable
  Object; do not add a second host or a parallel implementation.
- The user works from the phone: changes come from this chat as pull requests,
  the user merges them in the GitHub app, and `main` deploys automatically.
  Running the same application locally with Wrangler (`npm run dev`) is
  optional, for checking something specific.

## Pull request workflow

- Deliver repository changes through pull requests. For stacked work, target
  the preceding PR's branch; the bottom PR targets `main`.
- The repository merges with "Rebase and merge" only. Keep each branch a linear
  series of commits on its base, with no merge commits. After a parent PR
  merges, rebase its child onto `main` and retarget it before it is merged.
- Keep dependent PRs stacked and describe their order. Retarget a child after
  its parent is merged, without merging either PR on the user's behalf.
- Use a focused branch named `<type>/<area>/<short-slug>` (for example
  `feat/ui/shadcn`, `fix/meta/review-issues`) unless the user specifies a name.
- Commit the relevant changes, push the branch, and open a pull request as part
  of completing the requested work.
- The user reviews and merges pull requests. Do not merge a pull request or
  push changes directly to `main` unless the user explicitly asks.
- Keep each pull request focused and explain what changed and why. Include
  appropriate validation and any material limitations in the description.
- Check the working tree before editing and preserve unrelated user changes.
- Run checks appropriate to the change. Documentation-only changes do not
  require adding application tests.
- If authentication, permissions, or repository setup prevent creating a pull
  request, preserve the prepared changes and clearly report the blocker.
- Include the pull request link in the final handoff.

## Repository boundary

- Keep project work inside this repository: helper scripts, dependencies,
  package-manager caches, runtime data, test artifacts, and PR body drafts.
- Do not install tools globally, create project files in temporary directories,
  or run external plugin helper scripts for this project.
- Use npm with `--cache ./.cache/npm` for dependency operations. Keep runtime
  data in `./data` and disposable artifacts in `./.cache`, both ignored by Git.
- Use repository-local scripts and dependencies for development and validation.

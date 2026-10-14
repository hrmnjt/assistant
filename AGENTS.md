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
- Develop on the user's Mac initially. Keep the home Linux PC, a dedicated
  server, and Cloudflare compute as future hosting options; do not assume a
  final deployment target.

## Pull request workflow

- Deliver repository changes through pull requests targeting `main`.
- Use a focused branch with the `codex/` prefix unless the user specifies a name.
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
- Include the pull request link in the final handoff. When available, attach
  the pull request to the current Codex chat.

# Review archive — 17 October 2026

This archive records the household assistant's implementation and architectural review at [`c85e65ac75b751767b3acce5e29804aadf637684`](https://github.com/hrmnjt/assistant/commit/c85e65ac75b751767b3acce5e29804aadf637684). It preserves evidence and recommended follow-up work; GitHub issues track current implementation status.

- [Implementation and product review](review.md)
- [Pi Durable architectural review](architecture.md)
- [Reproduction evidence](evidence.md)
- [Prioritized GitHub issue index](issues.md)

## How to read the findings

Confirmed requirements remain in the [root README](../../../README.md). A reproduced defect, an observed limitation, a validation gap, and an architecture proposal are distinct kinds of work. Creating an issue does not approve a new product policy or choose a hosting target. The architecture diagram is a proposed direction.

All 44 existing tests and the production build passed during the review. Nine targeted probes exposed behavior outside that suite; their results and limitations are in the evidence document. Live iCloud, ChatGPT account eligibility/inference, installed iPhone push, and remote access still require acceptance validation. Concurrent Cloudflare prototype work was outside the reviewed snapshot.

## Suggested order

1. Calendar outcome reconciliation and recovery after reload.
2. Notification validation/fairness and recurring-occurrence correctness.
3. Chat reliability and concrete external acceptance checks.
4. Restore/restart procedures, diagnostics, migrations, and CI.
5. Proposed Pi lifecycle, durable workflow, and streaming improvements.

Preserve human confirmation, the same underlying calendar records, shared task ownership, and the agreed POC scope throughout. The Mac, home Linux PC, dedicated server, and Cloudflare compute remain hosting options.

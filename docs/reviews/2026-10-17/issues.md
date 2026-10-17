# Review follow-up issues

Created from the 17 October 2026 review of commit
`c85e65ac75b751767b3acce5e29804aadf637684`. GitHub is authoritative for current status.

P1 means address before depending on the affected flow or complete the critical
validation; P2 is a focused reliability or maintenance improvement; P3 is a later
enhancement. These priorities are recommendations. Decision and architecture
issues preserve open choices rather than changing confirmed requirements.

| ID     | Priority | Type                                 | GitHub issue                                                                                                                           |
| ------ | -------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| CAL-1  | P1       | Bug · reproduced                     | [Resolve uncertain calendar writes after external edits and expiry](https://github.com/hrmnjt/assistant/issues/9)                      |
| CAL-2  | P1       | Bug · reproduced                     | [Restore pending and uncertain previews after reload or sign-in](https://github.com/hrmnjt/assistant/issues/10)                        |
| REM-1  | P2       | Bug · reproduced                     | [Revalidate task deadline notices before sending push](https://github.com/hrmnjt/assistant/issues/11)                                  |
| REM-2  | P2       | Bug · reproduced                     | [Prevent blocked appointment notices from starving newer deliveries](https://github.com/hrmnjt/assistant/issues/12)                    |
| TASK-1 | P2       | Bug · reproduced                     | [Handle recurring-task rescheduling onto an existing occurrence](https://github.com/hrmnjt/assistant/issues/13)                        |
| TASK-2 | P2       | Requirement gap · inspection         | [Record occurrence-level completion timestamps and history](https://github.com/hrmnjt/assistant/issues/14)                             |
| DEC-1  | P2       | Open product decision                | [Define recurring reminder, quiet-hours, and restart catch-up policies](https://github.com/hrmnjt/assistant/issues/15)                 |
| CHAT-1 | P2       | Bug · inspection                     | [Preserve newer chat drafts and reject stale send results](https://github.com/hrmnjt/assistant/issues/16)                              |
| CHAT-2 | P2       | Limitation · reproduced              | [Paginate chat history and Updates without hiding unread records](https://github.com/hrmnjt/assistant/issues/17)                       |
| CHAT-3 | P2       | Bug · inspection                     | [Recognize documented assistant mentions within channel messages](https://github.com/hrmnjt/assistant/issues/18)                       |
| UI-1   | P2       | Bug · inspection                     | [Recover stale task and calendar editors with a fresh comparison](https://github.com/hrmnjt/assistant/issues/19)                       |
| CHAT-4 | P2       | Bug · reproduced                     | [Allow ordinary shared messages while AI requests are paused](https://github.com/hrmnjt/assistant/issues/20)                           |
| AI-1   | P2       | Budget gap · reproduced              | [Define and enforce inference budgets for compaction and generation](https://github.com/hrmnjt/assistant/issues/21)                    |
| AI-2   | P2       | OAuth conformance · inspection       | [Validate the pinned OAuth flow against documented identity and reconnect requirements](https://github.com/hrmnjt/assistant/issues/22) |
| AI-3   | P2       | Reliability improvement · inspection | [Expose safe AI connection health and per-message failure outcomes](https://github.com/hrmnjt/assistant/issues/23)                     |
| VAL-1  | P1       | Acceptance validation                | [Verify the POC end to end with real accounts, calendars, and installed iPhones](https://github.com/hrmnjt/assistant/issues/24)        |
| OPS-1  | P2       | Operational gap · inspection         | [Add coordinated household backup and verified restore procedures](https://github.com/hrmnjt/assistant/issues/25)                      |
| OPS-2  | P2       | Maintenance gap · inspection         | [Introduce versioned migrations for domain and durable workflow state](https://github.com/hrmnjt/assistant/issues/26)                  |
| OPS-3  | P2       | Operational gap · inspection         | [Drain work on shutdown and recover failed household runtimes](https://github.com/hrmnjt/assistant/issues/27)                          |
| AUTH-1 | P2       | Account lifecycle gap · inspection   | [Provide local household password rotation and session revocation](https://github.com/hrmnjt/assistant/issues/28)                      |
| AUTH-2 | P2       | Hardening proposal                   | [Bound sign-in throttling state and avoid blocking password checks](https://github.com/hrmnjt/assistant/issues/29)                     |
| ARCH-1 | P2       | Architecture proposal                | [Use Pi submissions as the authoritative assistant inbox and bind authenticated actors](https://github.com/hrmnjt/assistant/issues/30) |
| ARCH-2 | P2       | Architecture proposal                | [Commit workflow receipts atomically and bridge domain writes with stable commands](https://github.com/hrmnjt/assistant/issues/31)     |
| ARCH-3 | P2       | Architecture proposal                | [Add durable job and host-wakeup adapters around one household runtime](https://github.com/hrmnjt/assistant/issues/32)                 |
| ARCH-4 | P3       | Architecture proposal                | [Stream committed household snapshots and updates through a stable UI protocol](https://github.com/hrmnjt/assistant/issues/33)         |
| UI-2   | P3       | Maintenance proposal                 | [Separate frontend responsibilities and consolidate layered styles](https://github.com/hrmnjt/assistant/issues/34)                     |
| QA-1   | P2       | Validation infrastructure            | [Run existing checks in CI and add focused browser and restart coverage](https://github.com/hrmnjt/assistant/issues/35)                |
| QA-2   | P2       | Assistant behavior validation        | [Evaluate real assistant clarification and proposal behavior with a small scenario set](https://github.com/hrmnjt/assistant/issues/36) |
| DEC-2  | P3       | Open product decision                | [Define shared-channel unread and human-message notification behavior](https://github.com/hrmnjt/assistant/issues/37)                  |

Suggested order: calendar recovery and reminder defects; recurrence and chat
reliability; external acceptance and restore/restart procedures; then the proposed
Pi lifecycle, workflow, and streaming changes. Each issue describes its own
dependencies and acceptance criteria. Related work can share a focused PR when
that keeps the implementation coherent.

See the [implementation review](review.md), [architectural review](architecture.md),
and [reproduction evidence](evidence.md) for the archived assessment.

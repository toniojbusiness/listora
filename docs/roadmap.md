# Listora roadmap

The phases of the adopted implementation plan, in the order they are built. This file is a
short overview and is not edited by feature PRs: **task status lives in the project's task
tracker and in merged PRs**, and each feature's design is in its own doc under
[features/](features/). Architecture context: [architecture.md](architecture.md).

A **gate** is an external credential or approval. Work before a gate is built and tested with
fakes, and only the live part waits for the gate. Gates: **G-eBay** (developer keys), **G-AI**
(Anthropic key), **G-Apple** (developer program), **G-AWS** (accounts and domain), **G-Depop**
(partner API approval), **G-Stripe** (account).

| Phase | Goal                                                                                                                                            | Gates                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 0     | Foundations: toolchain and CI, iOS scaffold, API contract, schema, API skeleton, operation engine, storage, AI layer, adapter framework         | none                     |
| 1     | M1 vertical slice: photo, AI draft, review, price, item, and eBay with honest status (fakes first, then the eBay sandbox)                       | G-eBay, G-AI             |
| 2     | M2 auto-delist and multi-marketplace: sale intake and fan-out, assisted mode end to end, Share Extension, email sales, Depop                    | G-Depop                  |
| 3     | M3 accounts, billing, and launch readiness: billing, AI cost controls, infrastructure, production auth, observability, release, eBay production | G-Stripe, G-Apple, G-AWS |
| 4     | Import, matching, profit, and organization: eBay and Depop import, assisted import, matching, profit and fees, storage locations                | none                     |
| 5     | Selling operations: repricing rules, relist and refresh, shipping workflow, offers                                                              | none                     |
| 6     | Intelligence: analytics, desktop web app, sourcing, insights, AI assistant, autopilot                                                           | licensed data            |

Task ids (`T-01` to `T-51`) in code comments and docs refer to the plan's task list; their
scope, dependencies, and status are in the task tracker.

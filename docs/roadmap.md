# Listora roadmap

This is the phased task list from the adopted implementation plan. Each task ships as one PR.
Tasks in the same **group** can run in parallel once their dependencies are merged. A
**gate** is an external credential or approval. Work before a gate is built and tested with
fakes, and only the live part waits for the gate. Architecture context:
[architecture.md](architecture.md).

Gates: **G-eBay** (developer keys), **G-AI** (Anthropic key), **G-Apple** (developer program),
**G-AWS** (accounts and domain), **G-Depop** (partner API approval), **G-Stripe** (account).

## Phase 0 - Foundations (no credentials)

| ID   | Task                                                                                                                                                        | Deps       | Group |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----- |
| T-01 | Monorepo and backend toolchain, `scripts/dev-db.sh`, CI (Linux), `.env.example`, docs                                                                       | -          | A     |
| T-02 | iOS scaffold: XcodeGen, SwiftUI app + Share Extension placeholder, SPM modules, `make ios-test`, macOS CI                                                   | T-01       | B     |
| T-03 | OpenAPI v1 contract + codegen (TS types, Swift client) + drift check                                                                                        | T-01       | B     |
| T-04 | DB schema v1 + migrations + gapless per-account SKU allocator                                                                                               | T-01       | B     |
| T-05 | API skeleton: zod env config, request-id logging, error model, dev auth, tenancy guard, items/photos CRUD                                                   | T-03, T-04 | C     |
| T-06 | Operation engine: Graphile Worker, transactional enqueue, state machine, fake adapter with fault injection                                                  | T-04       | C     |
| T-07 | Storage + image pipeline: local/S3 drivers, upload sessions, derivatives, GPS strip, hashes                                                                 | T-05       | C     |
| T-08 | AI provider abstraction, model registry, price table, usage metering, budget guards, fake provider; wire the fake and Anthropic providers into the eval CLI | T-04       | C     |
| T-09 | Tag-text parsers (RN, CA, UPC/EAN, size, fiber, origin) + synthetic corpus + eval harness                                                                   | T-01       | B     |
| T-10 | Adapter framework: interfaces, capability flags, registry, conformance suite, assisted adapter base                                                         | T-06       | D     |

## Phase 1 - M1 vertical slice: photo → AI draft → review → price → item → eBay (fakes; sandbox at G-eBay)

| ID      | Task                                                                                               | Deps                   | Group |
| ------- | -------------------------------------------------------------------------------------------------- | ---------------------- | ----- |
| T-11    | Analysis service: prompt assembly, strict schema, provenance, variants, escalation + quota         | T-07, T-08, T-09       | D     |
| T-12    | iOS capture: multi-photo capture, library import, role tagging, GRDB drafts, resumable upload      | T-02, T-03, T-07       | D     |
| T-13    | iOS on-device tag reading: Vision text + barcodes uploaded with photos                             | T-02                   | B     |
| T-14    | Pricing v1: floor calculator, fee tables, AI-estimate tiers, research links, label guard           | T-05                   | D     |
| T-15    | `fake-ebay` server + eBay adapter (Trading subset, Media, Taxonomy, Fulfillment)                   | T-10                   | E     |
| T-16    | eBay connect + token vault + connection health                                                     | T-05, T-10             | E     |
| T-17    | eBay notifications: signature verification, orders, revocation, account deletion, backstop poll    | T-15, T-16             | F     |
| T-18    | iOS review + price screens: confidence-first review, cost, condition, price tiers                  | T-11, T-12, T-14       | F     |
| T-19    | iOS inventory, item detail with per-marketplace status, publish/price/end/retry on eBay            | T-05, T-06, T-15, T-18 | G     |
| M1 exit | Scripted E2E on simulator + local stack + fakes; then the same script on the eBay sandbox (G-eBay) | T-17, T-19             | -     |

## Phase 2 - M2 auto-delist and multi-marketplace

| ID   | Task                                                                                                                 | Deps             | Group |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ---------------- | ----- |
| T-20 | Auto-delist orchestrator: sale intake, fan-out, `delist_run`, re-alerts, double-sale incident                        | T-06, T-10, T-17 | H     |
| T-21 | Assisted mode end to end: task inbox, copy-assist, deep links, "Done" confirmation, reminders                        | T-10, T-19       | H     |
| T-22 | iOS Share Extension: link a shared marketplace listing URL to an item or import placeholder                          | T-02, T-05       | H     |
| T-23 | Email sale detection: inbound address, DKIM/SPF, deterministic parsers, "ask before auto-delist"                     | T-05, T-20       | H     |
| T-24 | `fake-depop` from Depop's OpenAPI + Depop adapter (PKCE, rotating refresh, verify by GET, webhooks); live at G-Depop | T-10             | H     |
| T-25 | Connection health dashboard: API connections, email forwarding, expiry warnings, reauth push                         | T-16, T-23, T-24 | I     |
| T-26 | Manual mark-sold, sale lifecycle (confirm, cancel, return → relist prompt), fee lines                                | T-20             | I     |
| T-27 | Full-stack E2E suite: photo → list on eBay/Depop fakes + assisted Poshmark → sale → auto-delist                      | T-20..T-26       | J     |

### Browser automation (decision D1, revised 2026-10-24)

The marketplaces permitted automation where no API exists, so Poshmark, Mercari, and Depop
(until G-Depop) are automated in the cloud; assisted mode stays their fallback.

| ID                  | Task                                                                                                                             | Deps                    | Group |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----- |
| automation-runner   | Browser runner (Playwright, on-demand Fargate), session vault, safety rules, `automation` mode, sale-check scheduling, fake site | T-06, T-10              | H     |
| automation-poshmark | Poshmark automation adapter: scripts for list, edit, price, delist, relist, read-back, sold orders                               | automation-runner       | I     |
| automation-mercari  | Mercari automation adapter (the same scripts for Mercari)                                                                        | automation-runner       | I     |
| automation-depop    | Depop automation adapter, until its partner API (T-24) is granted                                                                | automation-runner       | I     |
| automation-linking  | Linking: the iPhone screen to log into a marketplace, and the API endpoint that stores its session (`linkAutomationSession`)     | automation-runner, T-22 | I     |

## Phase 3 - M3 accounts, billing, launch readiness

| ID   | Task                                                                                     | Deps       | Group | Gate              |
| ---- | ---------------------------------------------------------------------------------------- | ---------- | ----- | ----------------- |
| T-28 | Billing + entitlements: Stripe (fake), StoreKit 2, App Store notifications, plan quotas  | T-05, T-11 | K     | G-Stripe, G-Apple |
| T-29 | AI cost dashboards, alerts, kill switch                                                  | T-08       | K     | -                 |
| T-30 | Infra as code: CDK stacks + GitHub OIDC deploy workflow (`cdk synth` offline)            | T-01       | K     | G-AWS             |
| T-31 | Production auth: Cognito driver (Sign in with Apple, email OTP), in-app account deletion | T-05       | K     | G-AWS, G-Apple    |
| T-32 | Observability/SLO metrics and alarms (delist latency, verified-success rate, AI cost)    | T-06       | K     | -                 |
| T-33 | Security and privacy hardening: threat model, deletion jobs, privacy policy/ToS drafts   | T-17, T-24 | K     | Legal review      |
| T-34 | Release pipeline: signing, TestFlight upload workflow                                    | T-02       | K     | G-Apple           |
| T-35 | eBay production readiness: Growth Check packet, deletion endpoint live on staging        | T-17, T-30 | L     | G-eBay, G-AWS     |

T-29 ships the AI cost reports, the kill switch, and account blocks as the admin CLI
(`npm run admin`), and the spend alerts as the worker's hourly spend check. Admin HTTP
endpoints are deferred: Listora is for personal use for now, and the CLI is enough. The
CloudWatch alarm that notifies on AI daily cost comes with T-32.

## Phase 4 - Import, matching, profit, organization

| ID   | Task                                                                                 | Deps       | Group   |
| ---- | ------------------------------------------------------------------------------------ | ---------- | ------- |
| T-36 | eBay import (GetSellerList/GetItem)                                                  | T-15       | M       |
| T-37 | Depop import (GET products)                                                          | T-24       | M       |
| T-38 | Assisted import for Poshmark/Mercari (Share Extension batch linking, competitor CSV) | T-22       | M       |
| T-39 | Matching engine: ids, attribute similarity, pHash, LLM tie-break, review UI          | T-36, T-37 | after M |
| T-40 | Profit and fees: actual eBay/Depop fees, Poshmark/Mercari fee tables, expenses, ROI  | T-26       | M       |
| T-41 | Storage locations + QR labels + scan-to-open                                         | T-19       | M       |

## Phases 5 and 6 - Selling operations and intelligence

Dependencies for these phases are set when each phase is planned.

| ID   | Task                                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------- |
| T-42 | Smart repricing rules through the operation engine (never reprice eBay in response to other sites' prices) |
| T-43 | Relist/refresh: eBay relist, Depop delete + recreate with a new SKU, assisted tasks elsewhere              |
| T-44 | Shipping workflow: sold queue with storage location, ship-by, label status                                 |
| T-45 | Offers: eBay Negotiation API, Depop offers API                                                             |
| T-46 | Analytics v1 (cross-marketplace comparisons need eBay consent; Depop analytics need authorization)         |
| T-47 | Desktop web app (Next.js) for bulk management                                                              |
| T-48 | Sourcing mode (needs licensed comps; otherwise a labeled AI estimate)                                      |
| T-49 | Personalized insights: descriptive statistics only; no training on eBay or Depop content without consent   |
| T-50 | AI assistant: tool calling over the account's own data, budgeted per plan                                  |
| T-51 | Autopilot: rules engine + approvals + operation engine                                                     |

**Critical path without credentials:** T-01 → (T-02, T-03, T-04, T-09, T-13) → (T-05, T-06,
T-08) → (T-07, T-10, T-11, T-14) → (T-12, T-15, T-16) → (T-17, T-18) → T-19 → M1 E2E on fakes
→ Phase 2 groups H and I → T-27.

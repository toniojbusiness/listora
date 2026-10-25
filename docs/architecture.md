# Listora architecture

Listora is a mobile-first operating system for resellers: take photos once, create the item
once, and manage it everywhere (eBay, Depop, Poshmark, Mercari). This is the engineering
overview every task reads first: the principles that cut across features, and links to the
features' own docs in [features/](features/). Keep it accurate and short. If your change makes
something here wrong, fix this file in the same PR; a feature's details go in its own file
([README.md](README.md) says where). The phases are in [roadmap.md](roadmap.md).

## 1. Product invariants

These two rules from the product owner override every other design choice.

1. **Authorized integrations only.** Listora uses official marketplace APIs, authorized partner
   channels, or browser automation the marketplace has permitted (decision D1,
   [automation.md](features/automation.md)). It never stores marketplace passwords, never solves or
   bypasses CAPTCHAs or bot checks, never works around anti-bot protection, and never automates a
   marketplace in ways that put a seller's account at risk. Where none of these channels is
   available, or automation meets a check it must not pass, Listora uses **assisted mode**: it
   prepares the work and the user does the final step.
2. **Never report false success.** A marketplace action is shown as done only after one of two
   things: a read-back from the marketplace (its API, or the automated browser session)
   confirms the desired state, or the user explicitly confirms an assisted task. Every failure
   is visible and can be retried. See [operations.md](features/operations.md).

## 2. Stack

| Area       | Choice                                                                                            | Why                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| iPhone app | Native Swift 6 / SwiftUI, iOS 18+, XcodeGen, local SPM modules, GRDB                              | Camera, Vision OCR, barcodes, background upload, Share Extension, and StoreKit are native |
| Backend    | TypeScript on Node 26: Fastify API plus a worker process                                          | One language for the API, worker, infra (CDK), and the later web app                      |
| Contract   | OpenAPI 3.1 in `packages/api-contract` → generated TS types and Swift client; CI fails on drift   | Client and server cannot drift apart                                                      |
| Database   | PostgreSQL 18 (Homebrew locally, RDS in prod), Kysely, plain SQL migrations                       | Relational inventory, strong constraints, JSONB for marketplace payloads                  |
| Jobs       | Graphile Worker (Postgres-backed), enqueued in the same transaction as the operation row          | No second datastore; an operation can't be recorded without its job, or the reverse       |
| Photos     | Client sends JPEG without GPS; S3 + CloudFront (local-disk driver in dev); `sharp` derivatives    | Marketplaces fetch images by URL; GPS stripping protects privacy                          |
| Auth       | Amazon Cognito (Sign in with Apple, email OTP); dev OTP driver                                    | Managed and in the same AWS account                                                       |
| Billing    | Stripe (web) plus StoreKit 2 (in-app), with entitlements unified on the server                    | App Store rule 3.1.3(b)                                                                   |
| Hosting    | AWS: ECS Fargate, ALB, RDS, S3/CloudFront, SES, KMS, Secrets Manager, CloudWatch; CDK (`infra`)   | Standard, robust, one security boundary                                                   |
| Push       | APNs (token-based key); fake driver in dev                                                        | Delist alerts and assisted tasks                                                          |
| Automation | Playwright's headless Chromium in the on-demand browser runner (Fargate; a child process locally) | Poshmark, Mercari, and Depop without an API ([automation.md](features/automation.md))     |
| Tooling    | npm workspaces, TypeScript strict, ESLint (flat config) + Prettier, Vitest                        | No extra package manager or build system                                                  |

### TypeScript conventions

- **No JavaScript build step.** Node 26 runs `.ts` files directly through type stripping
  (`node src/main.ts`), both in development and in production. `tsc --build` is only a type
  checker. It emits declarations into each workspace's gitignored `.tsbuild/` so that project
  references work.
- Because Node strips types without compiling them, code uses only erasable syntax
  (`erasableSyntaxOnly`): no `enum`, `namespace`, or constructor parameter properties. Use
  string-literal unions and `as const` objects instead.
- Relative imports name the real file, `./money.ts`, never `./money.js`. ESLint enforces this.
  Type-only imports use `import type`.
- Workspace packages export their `src/index.ts` directly (`"exports": { ".": "./src/index.ts" }`)
  and are consumed as `@listora/<name>`. A package may also export a `./testing` subpath with
  integration-test helpers for other workspaces (`@listora/db/testing`); runtime code never
  imports one.
- TypeScript is pinned to 6.0.x because typescript-eslint does not support TypeScript 7 yet.
- `npm run lint` runs ESLint with a 6 GB heap. Type-aware linting holds a TypeScript program
  for every workspace in one process, which outgrew Node's default heap of about 2 GB.
- Configuration comes only from environment variables. Each process parses them once at
  startup and fails fast (the API with a zod schema in `apps/api/src/config.ts`). Error
  messages name the bad key but never print its value. Every key is documented in
  `.env.example`.
- Logging goes through `createLogger()` from `@listora/shared`: structured JSON (pino),
  with credentials redacted by `REDACTED_LOG_PATHS`. Never log tokens, passwords, or full
  marketplace payloads that contain secrets.
- Money is always **integer cents plus a currency** (`Money` in `@listora/shared`). Never use
  floating-point dollars. The database also stores integer cents with a currency.
- Switches over unions end with `assertNever`, and ESLint's `switch-exhaustiveness-check`
  is on. Adding a capability mode or status then fails the type check until every switch
  handles it.

The iOS conventions are in [features/ios.md](features/ios.md).

## 3. Repository layout

```text
apps/
  api/          Fastify HTTP API (@listora/api)
  worker/       Background worker: operation engine, plus one module per feature's jobs in
                src/features/ (account deletion, AI spend check, item analysis, photo
                processing, trust metrics, the daily connection health check, the delist SLA,
                push delivery, sale fees, the morning summary); and the on-demand browser runner
                (src/runner/main.ts)
                (@listora/worker)
  admin/        Operator CLI (`npm run admin`): AI cost reports, spend check, AI kill switch
                and account blocks (@listora/admin)
  ios/          iPhone app: XcodeGen project.yml, app and Share Extension targets, Packages/
                (Core, DesignSystem, APIClient, Features); not an npm workspace
packages/
  ai/           AI provider layer: provider interface, model registry, price table, usage
                metering, budget guards, plan quota counter, fake and Anthropic providers
                (@listora/ai)
  analysis/     Item analysis: canonical vocabulary, marketplace copy limits, prompt assembly,
                the strict output schema, provenance, escalation, the analysis job
                (@listora/analysis)
  pricing/      Pricing v1: versioned fee tables, cost floor, AI-estimate tiers, research
                links, sold-data label guard; pure, no I/O (@listora/pricing)
  api-contract/ OpenAPI v1 contract + generated TS and Swift code (@listora/api-contract)
  db/           SQL migrations, migration runner, Kysely types, SKU allocator (@listora/db)
  storage/      Object storage: local-disk driver with signed upload URLs, S3 driver
                (@listora/storage)
  photos/       Image pipeline: verification, metadata stripping, derivatives, sha256 and pHash,
                the photo processing job, an item's photo-set hash (@listora/photos)
  marketplaces/ Marketplace adapter framework: interface, capabilities, registry, listing content,
                assisted adapters, conformance suite; the eBay adapter and connect client (ebay/)
                and the Depop adapter (depop/); fake marketplace, fake eBay, and fake Depop with
                fault injection (@listora/marketplaces)
  connections/  Marketplace account connections: OAuth connect, the token vault (local key or KMS)
                for OAuth tokens and browser sessions, the session vault, use-time credentials
                with single-flight refresh, health checks, revocation (@listora/connections)
  automation/   Browser automation (decision D1): the Playwright runner, its safety rules, the
                automation adapter base, sale-check scheduling, the runner launcher, the
                fake marketplace site, and the Poshmark, Mercari, and Depop adapters with their
                fake sites (poshmark/, mercari/, depop/) (@listora/automation)
  operations/   Operation engine: enqueue, state machine, executor, crash recovery, listing
                drift resync (@listora/operations)
  sales/        Sale intake: inbound events, recording sales (which starts their auto-delist);
                the sale lifecycle, fee lines, payout and profit, the profit dashboard's math;
                eBay notifications, the order poll, eBay account deletion (@listora/sales)
  auto-delist/  The auto-delist orchestrator: the fan-out after a sale, delist runs and their
                per-marketplace truth, SLA re-alerts, double-sale incidents (@listora/auto-delist)
  push/         Push notifications: the notification, the sender interface and its recording
                fake, the outbox job (@listora/push)
  today/        The Today screen: card rules, the summary's plain queries, the money summary, the
                morning summary job and its setting (@listora/today)
  accounts/     Account lifecycle: deleted identities, the account deletion tombstone and its job,
                Cognito user administration, marketplace grant revocation (@listora/accounts)
  observability/ Trust metrics: metric catalog, CloudWatch EMF output, the worker's metrics job
                (@listora/observability)
  shared/       Types and utilities used by every backend workspace (@listora/shared)
  testing/      Test-only helpers: test DB URL, scratch databases, process harness (@listora/testing)
  tag-parse/    Tag-text parsers: RN/CA, UPC/EAN, size, fiber, origin, style (@listora/tag-parse)
  eval/         Synthetic tag corpus (corpus/) and the eval harness CLI (@listora/eval)
  e2e/          Local end-to-end stack: the API and worker with fakes on a scratch database and
                a signed-in user, which the iOS UI tests run against (@listora/e2e)
infra/          AWS CDK v2 app: one environment per synth, stacks per lifecycle (@listora/infra)
scripts/
  dev-db.sh     Local PostgreSQL 18 cluster in .local/pg
  dev-browser.sh  The browser runner's headless Chromium, in .local/playwright
  container-smoke.sh  Builds the application image and runs it as AWS does (CI)
  ios-release.sh  iOS release archive and TestFlight upload (make ios-archive, ios-testflight)
Dockerfile      Images: `app` runs the API and the worker; `runner` adds headless Chromium
docs/           This overview, the roadmap, and one doc per feature in docs/features/
Makefile        iOS commands (make ios-test, ios-lint, ...)
```

New backend libraries go in `packages/<name>` (for example `packages/marketplaces` for
adapters). Add each one to the root
`tsconfig.json` references. Tests sit next to the code: `*.test.ts` files are unit tests with
no external services, and `*.int.test.ts` files are integration tests against the real local
Postgres.

### Where a feature plugs in

Independent features touch independent files, so parallel branches do not conflict. A feature
adds its own files to these places instead of editing a shared list:

- **API routes.** A folder under `apps/api/src/<feature>/` with `routes.ts` and a
  `feature.ts` that exports `feature: ApiFeature`. `buildApp` registers every folder's
  `feature.ts` that `apps/api/src/features.ts` finds; app.ts lists only the routes every
  deployment has (health, the auth driver's, the local storage driver's).
- **Worker jobs.** A file `apps/worker/src/features/<feature>.ts` that exports
  `feature: WorkerFeature`: its Graphile Worker tasks and scheduled tasks. The worker runs every
  file `apps/worker/src/features.ts` finds and refuses two features with one task name.
- **API contract.** The resource's paths in `packages/api-contract/paths/<tag>.yaml` and its
  schemas in `packages/api-contract/components/schemas/<area>.yaml`, plus one `$ref` line per
  new path or component in the root `openapi.yaml` (see the package README).
- **Migrations.** A new pair of files named by UTC timestamp (section 6).
- **Docs.** The feature's file in `docs/features/` ([README.md](README.md)).

## 4. API conventions

The API is `apps/api`; every feature's routes follow these rules.

```text
src/
  main.ts        Entry point: config, logger, database, auth driver, graceful shutdown
  app.ts         buildApp(): request ids, error handling, routes (tests drive it with inject)
  features.ts    Finds each feature folder's feature.ts, whose routes buildApp registers
  config.ts      Environment, parsed once with a zod schema
  errors.ts      ApiError and the contract's ErrorResponse; HTTP status per error code
  contract/      Validators compiled from the bundled contract, and contractRoute()
  auth/          AuthDriver interface; the dev driver (with its /dev/auth endpoints) and the
                 Cognito driver
  account/       Account deletion (deleteAccount); the job that finishes it is in
                 @listora/accounts
  tenancy.ts     Tenant resolution: the tenancy guard
  idempotency.ts Idempotency-Key handling for POSTs
  items/ photos/ One folder per resource: routes.ts, feature.ts, repository.ts, mapping and views
  analyses/      Start, get, escalate, and apply analyses; the guard pre-check
  uploads/       Upload sessions (createUploadSession, getUploadSession) and the file claim
  storage/       The local storage driver's HTTP routes (signed PUTs, public GETs)
  pricing/       getItemPricing: loads cost, snapshots, and actual fees for @listora/pricing
  usage/         getUsage: the plan's quota use, from the counters the AI guards enforce
  listings/      Draft listings, the listing actions (publish, price, revise, end, relist,
                 verify) queued on the operation engine, honest views, shared-listing links
  operations/    Operations, their history, Retry, and Cancel
  tasks/         The task inbox: assisted steps, and the user's confirmation or dismissal
  connections/   Marketplace connections, the health summary and Retry check, connect attempts,
                 and the public OAuth callback
  marketplace-sessions/  Linking marketplaces by signing in: stores the session the app hands
                 over and reports its check (docs/features/marketplace-linking.md)
  sales/         The sales feed (listSales, getSale) with each sale's money, delist runs, and
                 double sales; Mark as sold (createSale), the lifecycle, and the relist question
  profit/        The profit dashboard (getProfit): the period's totals, breakdowns, dead stock
  today/         The Today summary (getToday) and the morning summary setting
  webhooks/      eBay's notification endpoint (`/webhooks/ebay`, outside `/v1` and the contract)
```

- **Routes come from the contract.** `contractRoute(app, deps, 'createItem', handler)` takes
  the method and URL from the contract by operationId and validates path, query, and body
  against the contract's own schemas (`loadContractDocument()` from `@listora/api-contract`,
  compiled with Ajv). A malformed path id is `404`; a query or body that breaks the schema is
  `422 validation_failed` with `fieldErrors`. Requests are held to `KnownX` values even where
  the shared schema is an open enum. Handler input and reply types are the generated contract
  types, so a reply that does not match the contract fails `tsc`. Integration tests also
  validate every response body against the contract (`call` in `src/test-support.ts`).
- **Tenancy guard.** Every `/v1` route is authenticated before its body is read, and its
  handler receives a `Tenant` (account and user). `AccountId` is a branded type that only
  `tenancy.ts` creates, and every repository function takes the `Tenant` and filters on its
  account, so another account's rows read as `404 not_found` and cannot be changed.
  `contractRoute` refuses operations the contract marks public. A person's first request
  creates their user, an account (SKU prefix from the email's initials), and the owner
  membership; a user without exactly one account gets `403 forbidden`. A token issued before
  its person deleted their account, or while the deletion still waits for the identity
  provider, is `401`, so it cannot provision a new account (checked under the lock deletion
  takes, so a deletion that commits meanwhile cannot be missed).
- **Idempotency.** A POST runs in one transaction that takes an advisory lock on (account,
  key) and stores its successful response in `idempotency_record` together with the change,
  so a retry replays it, a concurrent retry gets `409`, and a failure stores nothing. Each
  stored response also deletes up to 100 expired records (any account, oldest first, skipping
  rows another request holds), so the table stays about one retention period in size.
- **Errors and logs.** Every error is the contract's `ErrorResponse`; unexpected failures are
  a generic `500 internal_error` and only the log has details. Each request has an id (a
  sane incoming `X-Request-Id`, otherwise a UUID) that is in the response header, in
  `error.requestId`, and as `requestId` on every log line of the request.
- **Shutdown.** On SIGTERM the server stops accepting connections, finishes in-flight
  requests (asking their keep-alive clients to close), then closes the database pool.

Sign-in and account deletion are in [features/auth.md](features/auth.md), items in
[features/items.md](features/items.md), and listings and shared-listing links in
[features/marketplaces.md](features/marketplaces.md#listings-in-the-api-appsapisrclistings).

## 5. Local development: fakes and environment switches

Nothing requires a real credential to build or test. Every external service sits behind an
interface with a fake or dev driver, selected by an environment variable. Each switch below
lands with the task that introduces that dependency, and its keys are added to `.env.example`.

| Dependency       | Dev/test                                                                                                                                                                | Production                 | Switch                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------- |
| Postgres         | `scripts/dev-db.sh` cluster in `.local/pg`                                                                                                                              | RDS                        | `DATABASE_URL`, `TEST_DATABASE_URL`   |
| Marketplaces     | Fake marketplace with fault injection (`@listora/marketplaces`, `npm run dev:fake-marketplace`)                                                                         | Real adapters (T-15, T-24) | `FAKE_MARKETPLACE_URL`                |
| Assisted         | Poshmark, Mercari, and Depop run as assisted adapters until a seller links a session (D1) or connects Depop's API                                                       | The same                   | none                                  |
| Automation       | Fake marketplace site (`npm run dev:fake-site`) in local headless Chromium                                                                                              | Per-marketplace adapters   | `FAKE_AUTOMATION_SITE_URL`            |
| Browser runner   | A child process of the worker (`npm run dev:runner` by hand)                                                                                                            | ECS service, 0 to 1 tasks  | `BROWSER_RUNNER_LAUNCH`               |
| Storage          | Local-disk driver in `.local/storage`, with signed upload URLs served by the API                                                                                        | S3 + CloudFront            | `STORAGE_DRIVER=local\|s3`            |
| AI               | `FakeAiProvider` (fixtures keyed by photo-set hash, `default.json` for any other photo set)                                                                             | Anthropic API              | `AI_PROVIDER=fake\|anthropic`         |
| eBay             | `fake-ebay` server (OAuth consent, Commerce Identity, Trading XML subset, Media, Taxonomy, Fulfillment, signed notifications, fault injection; `npm run dev:fake-ebay`) | Sandbox, then production   | `EBAY_ENV=fake\|sandbox\|production`  |
| Depop            | `fake-depop` checked against Depop's published OpenAPI spec (OAuth with PKCE, rotating tokens, signed webhooks, fault injection; `npm run dev:fake-depop`)              | Sandbox, then production   | `DEPOP_ENV=fake\|sandbox\|production` |
| Email ingest     | Folder drop `.local/inbox/*.eml` + `POST /dev/email`                                                                                                                    | SES inbound                | `EMAIL_INGEST=folder\|ses`            |
| Auth             | Dev OTP printed to the API log (`POST /dev/auth/codes`, then `/dev/auth/sessions`)                                                                                      | Cognito                    | `AUTH_DRIVER=dev\|cognito`            |
| Payments         | Fake Stripe client + StoreKit configuration file                                                                                                                        | Stripe, App Store          | `BILLING_DRIVER=fake\|stripe`         |
| Push             | Recording fake that logs each notification (`packages/push`)                                                                                                            | APNs (with device tokens)  | `PUSH_DRIVER=fake`                    |
| Token encryption | Local AES-GCM key from `.env` (`TOKEN_ENCRYPTION_KEY`), for OAuth tokens and browser sessions                                                                           | KMS envelope encryption    | `TOKEN_KMS_KEY_ID`                    |
| iOS              | iPhone 17 simulator, photo-library fixtures                                                                                                                             | Device / TestFlight        | xcconfig `API_BASE_URL`               |

Live smoke tests for real providers skip automatically when their credential is absent. Fakes
must stay true to the real contract: shapes, error codes, and failure modes.

## 6. Data model

PostgreSQL, one schema, defined by the SQL migrations in `packages/db/migrations`.

- **Tenancy.** Every table has a non-null `account_id`, except `account` itself, `app_user`
  (a person's identity is global, and `membership` links it to accounts), the deleted
  identity tables `deleted_identity`, `account_deletion`, and `account_deletion_grant`, and the
  platform tables `ai_kill_switch` and `ai_control_audit`, which belong to no single tenant. Child
  rows reference parents through composite `(account_id, <parent>_id)` foreign keys, so the
  database rejects a row that points at another tenant's data. Deleting an account deletes
  all of its data.
- **Columns.** Ids are `uuidv7()`. Money is `bigint` cents (`*_cents`) plus a `currency`
  column (`currency_code` domain, USD only for now). Status-like columns are text with a
  CHECK of allowed values, mirrored by the lists in `packages/db/src/values.ts`.
- **Timestamps.** `created_at` and `updated_at` default to `now()`, and a trigger maintains
  `updated_at`. The append-only tables (`operation_event`, `audit_log`, `ai_usage_event`,
  `ai_control_audit`) have
  only `created_at`, since their rows never change.
- **History is kept.** A trigger rejects updates and deletes on the append-only tables, and
  deletes on `marketplace_operation`. The only changes it lets through are foreign-key actions
  caused by deleting a parent row (for example deleting the account), never direct statements
  or other triggers. So an operation and its `operation_event` history go away only with the
  account.
- **Invariants in the schema.** An operation can be `succeeded` only with `success_evidence`
  (`read_back` or `user_confirmation`), and `failed` only with a user-readable error. A create,
  revise, or relist has listing `content`, and no other kind does. Assisted connections can
  never hold credentials. `inventory_item.version` is bumped by a trigger on
  every update, for optimistic locking.

**Tables.** Each feature doc's Data section describes its tables.

- **Tenancy:** `account`, `app_user`, `membership`, and `sku_sequence` (gapless per-account
  SKUs such as `AJ-000184`, allocated by `createInventoryItem` / `allocateSku` in
  `@listora/db` inside the item-create transaction). `sku_prefix` lives on `account`, not on
  `membership` as the plan's data model sketched: SKUs and their counter are per account
  (decision D12), so every member of an account creates SKUs with the same prefix.
- **API:** `idempotency_record` (the stored first successful response per account and
  `Idempotency-Key`, kept 24 hours; written once, so it has no `updated_at`, and deleted in
  batches by later POSTs once expired).
- **Elsewhere:** connections and connect attempts in [connections.md](features/connections.md#data);
  automation runs and sale-check schedules in [automation.md](features/automation.md#data);
  inventory, photos, and history in [items.md](features/items.md); uploads in
  [photos.md](features/photos.md); AI in [ai.md](features/ai.md); marketplaces in
  [marketplaces.md](features/marketplaces.md#data); sales, delist runs, and user tasks in
  [operations.md](features/operations.md#data) (double-sale incidents in
  [auto-delist.md](features/auto-delist.md#data), the lifecycle and fee columns in
  [sales.md](features/sales.md#data), the profit dashboard's index in
  [profit.md](features/profit.md#data)); pricing in [pricing.md](features/pricing.md#data);
  deleted identities and account deletion in [auth.md](features/auth.md#data); the morning
  summary setting in [today.md](features/today.md#data). Billing
  (`subscription`, `entitlement`, `usage_counter`) has no doc of its own until billing lands (T-28);
  `usage_counter` holds the AI plan quotas ([ai.md](features/ai.md)).

**Migrations.** Each migration is a pair of plain SQL files, `<prefix>_name.up.sql` and
`<prefix>_name.down.sql`, run by Kysely's migrator in one transaction with a lock (`npm run
db:migrate`; in AWS, the deploy runs them before new code starts, see
[infra.md](features/infra.md)). Never edit a migration that has been merged; add a new one.

- **Names.** The prefix of a new migration is the UTC time you create it, `YYYYMMDDHHMMSS`
  (`date -u +%Y%m%d%H%M%S`), so branches written in parallel never pick the same name. The
  first migrations keep their four-digit numbers (`0001` to `0014`), which sort before every
  timestamp; no new numbered migration is added.
- **Order.** Migrations apply in name order, and the migrator refuses to apply a migration that
  sorts before one already applied (Kysely's default; it is never turned off). So at your final
  rebase before merge, if `origin/main` has a migration with a later timestamp than yours,
  rename yours (both files) to the current UTC time. Never rename a merged migration.
- **Checks.** `migrations.test.ts` checks that every migration has both files, that prefixes are
  unique, that timestamps are real UTC times, and that no numbered migration follows
  `0014_marketplace_connect`. The migration integration tests read the list from the directory, so a
  new migration edits no test.

A schema change updates the Kysely table types in `packages/db/src/schema.ts` and the value
lists in `values.ts` in the same change; `schema.int.test.ts` fails when they drift. `bigint`
columns read as numbers (throwing above `Number.MAX_SAFE_INTEGER`) and `date` columns as
`YYYY-MM-DD` strings. Write `jsonb` values with `jsonb(value)`.

## 7. Testing and CI

- `npm run check` runs the format check, lint (ESLint and shellcheck), type check, the API
  contract check, the offline `cdk synth` of every environment, unit tests, and integration
  tests. It must pass before merge. When iOS code
  is touched, `make ios-lint` and `make ios-test` must pass too. `make ios-test` runs the
  package, unit, and UI tests on an existing iPhone 17 simulator and keeps DerivedData in
  `.build/ios`. It runs them inside the local stack (`packages/e2e`, `npm run e2e:stack`): the
  API and worker from this checkout with the fake drivers, on a scratch database of the
  `scripts/dev-db.sh` cluster, with a signed-in test user. UI tests that go through the
  backend use it; the fake AI answers them from `apps/ios/ListoraUITests/FakeAI`. It retries a
  failing test up to twice and ends by naming the tests that failed and the ones that passed only
  on a retry (flaky: they do not block a merge but get a follow-up fix; the
  [README](../README.md#ci) has the rule).
- Integration tests use a real Postgres: the local `listora_test` database from
  `scripts/dev-db.sh` (locally and in CI), or `TEST_DATABASE_URL` when set. They fail, and
  never skip, when the database is unreachable. Tests that need their own schema create a
  throwaway database with `createScratchDatabase` from `@listora/testing` and drop it after.
- Tests cover acceptance criteria **and failure paths**. Process-level tests start the real
  entry points with `node src/main.ts` (see `startNodeProcess` in `@listora/testing`).
- Every marketplace adapter passes the shared conformance suite against its fake, and its payloads,
  validation results, and assisted tasks are pinned by golden files
  ([marketplaces.md](features/marketplaces.md#adapter-model)). Sample listing content for tests in
  any workspace comes from `@listora/marketplaces/testing`.
- **API contract.** `packages/api-contract` (the root `openapi.yaml` and the per-resource files it
  references) is the only place an endpoint or payload shape is defined. The server imports its
  types from `@listora/api-contract` and the iOS app uses the generated `ListoraAPI` Swift package.
  `npm run contract:check` lints the spec, fails when the committed generated code is stale, and
  tests the Swift package. Its conventions (error model, idempotency keys, pagination, Money) are in
  [packages/api-contract/README.md](../packages/api-contract/README.md).
- CI runs the same fresh-clone path as local development; see the CI section of the
  [README](../README.md#ci). A Linux job builds the application image and smoke-tests it
  (`scripts/container-smoke.sh`) when an image input changed. A macOS job runs
  `make ios-lint` and `make ios-test`, but only when a file the iOS build reads changed (macOS
  minutes cost 10 times Linux minutes); the Linux backend check runs on every non-draft pull
  request.

## 8. Feature docs

| File                                                               | Covers                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| [features/operations.md](features/operations.md)                   | The operation engine, the honest status vocabulary                             |
| [features/auto-delist.md](features/auto-delist.md)                 | Sale intake, the delist fan-out, delist runs, SLA re-alerts, double sales      |
| [features/connections.md](features/connections.md)                 | Connecting accounts, the token vault, health checks, the health dashboard      |
| [features/push.md](features/push.md)                               | Push notifications: the outbox job and the drivers                             |
| [features/marketplaces.md](features/marketplaces.md)               | The adapter interface, capabilities, assisted adapters, conformance, listings  |
| [features/ebay.md](features/ebay.md)                               | The eBay adapter, the fake eBay, the sandbox check                             |
| [features/ebay-notifications.md](features/ebay-notifications.md)   | eBay notifications, the order poll, eBay account deletion                      |
| [features/depop.md](features/depop.md)                             | Depop: the partner API adapter, dormant until access is granted                |
| [features/depop-automation.md](features/depop-automation.md)       | The Depop automation adapter until then, its mappings, the fake Depop site     |
| [features/automation.md](features/automation.md)                   | Browser automation for marketplaces without an API (decision D1)               |
| [features/poshmark.md](features/poshmark.md)                       | The Poshmark automation adapter, its mapping tables, and the fake Poshmark     |
| [features/marketplace-linking.md](features/marketplace-linking.md) | Linking Poshmark, Mercari, and Depop from the iPhone, and each session's check |
| [features/mercari.md](features/mercari.md)                         | The Mercari automation adapter, its mappings, the fake Mercari site            |
| [features/ai.md](features/ai.md)                                   | The AI pipeline, item analysis, cost metering and controls                     |
| [features/pricing.md](features/pricing.md)                         | Pricing data rules, floors, fee tables, tiers, the label guard                 |
| [features/photos.md](features/photos.md)                           | Uploads, storage drivers, photo processing                                     |
| [features/items.md](features/items.md)                             | Inventory items, item status, the audit log                                    |
| [features/auth.md](features/auth.md)                               | Sign-in drivers, the Cognito user pool, account deletion                       |
| [features/infra.md](features/infra.md)                             | Hosting and deploys                                                            |
| [features/costs.md](features/costs.md)                             | The personal environment's monthly cost                                        |
| [features/observability.md](features/observability.md)             | Logs, request ids, the signals alarms key on                                   |
| [features/ios.md](features/ios.md)                                 | iOS app conventions                                                            |
| [features/review.md](features/review.md)                           | The iPhone review, cost, and price screens and the interaction-time metric     |
| [features/design.md](features/design.md)                           | The iPhone app's design system, screenshots, and UI audit                      |
| [features/inventory.md](features/inventory.md)                     | The Inventory tab, the item screen, the listing flow and its API               |
| [features/sales.md](features/sales.md)                             | Mark as sold, the sale lifecycle, relisting by choice, fees, profit and ROI    |
| [features/tasks.md](features/tasks.md)                             | Assisted mode: the task inbox, copy-assist, confirmations, reminders           |
| [features/profit.md](features/profit.md)                           | The profit dashboard: periods, breakdowns, dead stock, the eBay licence rule   |
| [features/today.md](features/today.md)                             | The Today tab (the home), its card rules and money summary, the morning push   |

### Former section numbers

Code comments and merged migrations written before the split cite sections of this file by
number. They now live here:

| Old section                  | Now                                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1, 2, 3, 7, 11               | Sections 1, 2, 3, 5, and 7 of this file                                                                                                      |
| 3, "The API"                 | Section 4 of this file                                                                                                                       |
| 3, "Photos and storage"      | [features/photos.md](features/photos.md)                                                                                                     |
| 4, marketplace adapter model | [features/marketplaces.md](features/marketplaces.md), [features/ebay.md](features/ebay.md), [features/automation.md](features/automation.md) |
| 5, pricing data rules        | [features/pricing.md](features/pricing.md)                                                                                                   |
| 6, operation engine          | [features/operations.md](features/operations.md)                                                                                             |
| 8, AI pipeline               | [features/ai.md](features/ai.md)                                                                                                             |
| 9, data model                | Section 6 of this file and each feature doc's Data section                                                                                   |
| 10, hosting and deploys      | [features/infra.md](features/infra.md)                                                                                                       |

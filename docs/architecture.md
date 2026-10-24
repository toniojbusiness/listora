# Listora architecture

Listora is a mobile-first operating system for resellers: take photos once, create the item
once, and manage it everywhere (eBay, Depop, Poshmark, Mercari). This is the engineering
overview every task reads first. Keep it accurate and short. If your change makes something
here wrong, fix this file in the same PR. The task list is in [roadmap.md](roadmap.md).

## 1. Product invariants

These two rules from the product owner override every other design choice.

1. **Authorized integrations only.** Listora uses official marketplace APIs or authorized
   partner channels. It never stores marketplace passwords or sessions, never solves CAPTCHAs,
   never works around anti-bot protection, and never automates a marketplace in ways that put a
   seller's account at risk. If a marketplace has no authorized channel, Listora uses
   **assisted mode**: it prepares the work and the user does the final step.
2. **Never report false success.** A marketplace action is shown as done only after one of two
   things: an API read-back confirms the desired state, or the user explicitly confirms an
   assisted task. Every failure is visible and can be retried. See section 6.

## 2. Stack

| Area       | Choice                                                                                          | Why                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| iPhone app | Native Swift 6 / SwiftUI, iOS 18+, XcodeGen, local SPM modules, GRDB                            | Camera, Vision OCR, barcodes, background upload, Share Extension, and StoreKit are native |
| Backend    | TypeScript on Node 26: Fastify API plus a worker process                                        | One language for the API, worker, infra (CDK), and the later web app                      |
| Contract   | OpenAPI 3.1 in `packages/api-contract` → generated TS types and Swift client; CI fails on drift | Client and server cannot drift apart                                                      |
| Database   | PostgreSQL 18 (Homebrew locally, RDS in prod), Kysely, plain SQL migrations                     | Relational inventory, strong constraints, JSONB for marketplace payloads                  |
| Jobs       | Graphile Worker (Postgres-backed), enqueued in the same transaction as the operation row        | No second datastore; an operation can't be recorded without its job, or the reverse       |
| Photos     | Client resizes and strips GPS; S3 + CloudFront (local-disk driver in dev); `sharp` derivatives  | Marketplaces fetch images by URL; GPS stripping protects privacy                          |
| Auth       | Amazon Cognito (Sign in with Apple, email OTP); dev OTP driver                                  | Managed and in the same AWS account                                                       |
| Billing    | Stripe (web) plus StoreKit 2 (in-app), with entitlements unified on the server                  | App Store rule 3.1.3(b)                                                                   |
| Hosting    | AWS: ECS Fargate, ALB, RDS, S3/CloudFront, SES, KMS, Secrets Manager, CloudWatch; CDK           | Standard, robust, one security boundary                                                   |
| Push       | APNs (token-based key); fake driver in dev                                                      | Delist alerts and assisted tasks                                                          |
| Tooling    | npm workspaces, TypeScript strict, ESLint (flat config) + Prettier, Vitest                      | No extra package manager or build system                                                  |

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
  and are consumed as `@listora/<name>`.
- TypeScript is pinned to 6.0.x because typescript-eslint does not support TypeScript 7 yet.
- Configuration comes only from environment variables. Each process parses them once at
  startup and fails fast. Error messages name the bad key but never print its value. Every
  key is documented in `.env.example`.
- Logging goes through `createLogger()` from `@listora/shared`: structured JSON (pino),
  with credentials redacted by `REDACTED_LOG_PATHS`. Never log tokens, passwords, or full
  marketplace payloads that contain secrets.
- Money is always **integer cents plus a currency** (`Money` in `@listora/shared`). Never use
  floating-point dollars. The database also stores integer cents with a currency.
- Switches over unions end with `assertNever`, and ESLint's `switch-exhaustiveness-check`
  is on. Adding a capability mode or status then fails the type check until every switch
  handles it.

### iOS conventions

The details and commands are in [apps/ios/README.md](../apps/ios/README.md).

- `apps/ios/project.yml` is the only source of the Xcode project. XcodeGen generates
  `Listora.xcodeproj`, which is gitignored and never edited by hand.
- Swift 6 language mode with complete strict concurrency, and warnings are errors.
- Code lives in local Swift packages: `Core` (models and utilities, no UI), `DesignSystem`
  (palette, typography, spacing, components), `APIClient` (generated from the OpenAPI
  contract in T-03), and `Features` (one library per feature). A feature never imports another
  feature; `AppFeature` composes them into the tab shell. The app target only starts
  `AppFeature`.
- Configuration comes only from the build configuration's xcconfig file (`Dev-Debug`,
  `Staging-Release`, `Prod-Release`) through Info.plist. `AppConfiguration` validates it at
  launch and stops the app with an error that names the bad key. Only Dev may use plain HTTP.
- Views use `DesignSystem` tokens, never raw colors or sizes, so light and dark mode stay
  consistent. A test checks WCAG AA contrast for every text and background pair.
- Tests use Swift Testing; UI tests use XCTest. `make ios-lint` (SwiftLint and SwiftFormat)
  must be clean.

## 3. Repository layout

```text
apps/
  api/          Fastify HTTP API (@listora/api)
  worker/       Background worker: operation engine, polls, health jobs (@listora/worker)
  ios/          iPhone app: XcodeGen project.yml, app and Share Extension targets, Packages/
                (Core, DesignSystem, APIClient, Features); not an npm workspace
packages/
  ai/           AI provider layer: provider interface, model registry, price table, usage
                metering, budget guards, fake and Anthropic providers (@listora/ai)
  api-contract/ OpenAPI v1 contract + generated TS and Swift code (@listora/api-contract)
  db/           SQL migrations, migration runner, Kysely types, SKU allocator (@listora/db)
  shared/       Types and utilities used by every backend workspace (@listora/shared)
  testing/      Test-only helpers: test DB URL, scratch databases, process harness (@listora/testing)
  tag-parse/    Tag-text parsers: RN/CA, UPC/EAN, size, fiber, origin, style (@listora/tag-parse)
  eval/         Synthetic tag corpus (corpus/) and the eval harness CLI (@listora/eval)
infra/          AWS CDK stacks (T-30)
scripts/
  dev-db.sh     Local PostgreSQL 18 cluster in .local/pg
docs/           This overview and the roadmap
Makefile        iOS commands (make ios-test, ios-lint, ...)
```

New backend libraries go in `packages/<name>` (for example `packages/marketplaces` for
adapters). Add each one to the root
`tsconfig.json` references. Tests sit next to the code: `*.test.ts` files are unit tests with
no external services, and `*.int.test.ts` files are integration tests against the real local
Postgres.

## 4. Marketplace adapter model

All marketplace logic lives behind one `MarketplaceAdapter` interface. The engine and the UI
never branch on the marketplace name. They branch on **capability flags**, which can change
for a single connection; for example, Depop switches from assisted to API once partner access
is granted.

```ts
type Mode = 'api' | 'assisted' | 'bulk_file' | 'none';
interface MarketplaceCapabilities {
  connect: 'oauth' | 'none';
  create: Mode;
  updatePrice: Mode;
  updateDetails: Mode;
  delist: Mode;
  relist: Mode;
  markSold: Mode | 'not_needed';
  verifyRead: 'api' | 'user_confirm'; // how success is established
  importListings: 'api' | 'share_sheet' | 'bulk_file' | 'none';
  saleDetection: Array<'webhook' | 'poll' | 'email' | 'manual'>;
  imageTransport: 'url_fetch' | 'upload' | 'user_saves_photos';
  taxonomy: 'api' | 'static_snapshot';
  pricingData: 'sold_comps_in_listing_context' | 'none';
  externalSkuReusable: boolean; // Depop: false
  limits: { perSellerPerMin?: number; appPerMin?: number; appPerDay?: number };
}
interface MarketplaceAdapter {
  id: 'ebay' | 'depop' | 'poshmark' | 'mercari';
  capabilities(conn?: Connection): MarketplaceCapabilities;
  buildPayload(item: ItemSnapshot, variant: ListingVariant): Payload; // pure; golden-tested
  validate(payload: Payload): ValidationIssue[];
  execute(op: Operation, ctx: Ctx): Promise<Outcome>; // confirmed | rejected | transient | unknown | pendingUser
  readListing(ref: ListingRef, ctx: Ctx): Promise<RemoteListingState>;
  // Optional: listListings, listOrdersSince, parseWebhook, parseEmail, refreshCredentials
  healthCheck(conn: Connection): Promise<Health>;
}
```

| Marketplace | Mode                                            | Listing lifecycle                                                                                                 | Sale detection                               |
| ----------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| eBay        | API                                             | Trading API Add/Revise/End/Relist (keeps listings editable in Seller Hub); Media, Taxonomy, Fulfillment REST APIs | `ORDER_CONFIRMATION` webhook + 5-minute poll |
| Depop       | API after partner approval; assisted until then | `PUT` by per-attempt external SKU, `PATCH`, `DELETE`/mark-as-sold; verify with `GET`                              | `v1:order.*` webhooks + poll                 |
| Poshmark    | Assisted only (the guidelines ban automation)   | Copy-assist, photos saved in order, deep link, user confirms                                                      | DKIM-verified forwarded emails, manual       |
| Mercari     | Assisted only (no public API)                   | Same as Poshmark                                                                                                  | Forwarded emails, manual                     |

Assisted adapters implement `execute` by creating a `user_task` (deep link plus copy-assist
payload) and returning `pendingUser`. An assisted operation can finish only through a user
confirmation event.

## 5. Pricing data rules

The eBay API License forbids using eBay data to suggest prices without written consent. The
Depop rules allow Pricing Inspiration only inside that Depop listing. Without real sold data,
Listora shows a cost-based floor, an estimate labeled **"AI estimate - not based on sold
listings"**, and research links that open in the user's browser. The words "comps" and "sold"
appear only next to real sold data, and a test enforces this (T-14).

## 6. Operation engine: never false success

Every marketplace write is a `marketplace_operation` row whose state machine is driven by the
worker.

1. **Write path.** The API, or the auto-delist orchestrator, inserts the operation (`queued`,
   `idempotency_key`, desired-state snapshot) and enqueues its job **in the same
   transaction**.
2. **Execution.** Operations are serialized per listing (`queue_name = listing:<id>`). The
   adapter outcome determines the next state:
   - `confirmed`: the API succeeded **and** `readListing` shows the desired state → `succeeded`.
   - `rejected` (validation or permanent error) → `failed`, with a user-readable reason and fix.
   - `transient` (429, 5xx, network failure before send) → `retrying` with backoff and jitter
     (30 s, 2 m, 10 m, 30 m, 2 h, 6 h), then `failed` with a Retry action.
   - `unknown` (timeout after the request may have been sent) → `verifying`. `readListing`
     decides the result. The request is never re-sent blindly.
   - `pendingUser` (assisted) → `needs_user_action` until the user confirms.
3. **History.** Every transition appends an `operation_event` with a redacted
   request/response excerpt, error code, and attempt number.
4. **Invariant, enforced in code and tests:** no code path sets `succeeded` without a verified
   read-back or a user confirmation event. Chaos tests inject 429s, 5xx errors,
   timeouts after send, and crashes.
5. **Concurrency.** Token refresh is single-flight per connection; Depop rotates refresh
   tokens, so a lost write disconnects the seller. Rate limits use per-seller and app-wide
   token buckets.

**Auto-delist.** A sale event (webhook, poll, email, or manual entry) is deduplicated by
its order (see `sale` in section 9). Then, in one transaction, Listora records the sale, sets
the item to `sold_pending_delist`, and creates a high-priority delist operation or urgent
assisted task for every other listing. A `delist_run` gathers the per-marketplace results. If
anything is still unconfirmed after 10 minutes, Listora alerts the user again, and after 30
minutes it escalates the alert. A second sale opens a double-sale incident.

**Status vocabulary** shown to users: `Active (confirmed by eBay)`, `Delisting... retry 2 of 6`,
`Delist failed - Retry`, `Checking...`, `Action needed - delist on Poshmark`,
`Done (you confirmed)`. Assisted listings never show "confirmed by <marketplace>".

## 7. Local development: fakes and environment switches

Nothing requires a real credential to build or test. Every external service sits behind an
interface with a fake or dev driver, selected by an environment variable. Each switch below
lands with the task that introduces that dependency, and its keys are added to `.env.example`.

| Dependency       | Dev/test                                                                                                     | Production               | Switch                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------ | ------------------------------------ |
| Postgres         | `scripts/dev-db.sh` cluster in `.local/pg`                                                                   | RDS                      | `DATABASE_URL`, `TEST_DATABASE_URL`  |
| Storage          | Local-disk driver with signed upload URLs                                                                    | S3 + CloudFront          | `STORAGE_DRIVER=local\|s3`           |
| AI               | `FakeAiProvider` (fixtures keyed by photo-set hash)                                                          | Anthropic API            | `AI_PROVIDER=fake\|anthropic`        |
| eBay             | `fake-ebay` server (Trading XML subset, Media, Taxonomy, Fulfillment, signed notifications, fault injection) | Sandbox, then production | `EBAY_ENV=fake\|sandbox\|production` |
| Depop            | `fake-depop` generated from Depop's OpenAPI spec                                                             | Sandbox, then production | `DEPOP_ENV`                          |
| Email ingest     | Folder drop `.local/inbox/*.eml` + `POST /dev/email`                                                         | SES inbound              | `EMAIL_INGEST=folder\|ses`           |
| Auth             | Dev OTP printed to the console                                                                               | Cognito                  | `AUTH_DRIVER=dev\|cognito`           |
| Payments         | Fake Stripe client + StoreKit configuration file                                                             | Stripe, App Store        | `BILLING_DRIVER=fake\|stripe`        |
| Push             | Recording fake                                                                                               | APNs                     | `PUSH_DRIVER`                        |
| Token encryption | Local AES-GCM key from `.env`                                                                                | KMS envelope encryption  | `TOKEN_KMS_KEY_ID`                   |
| iOS              | iPhone 17 simulator, photo-library fixtures                                                                  | Device / TestFlight      | xcconfig `API_BASE_URL`              |

Live smoke tests for real providers skip automatically when their credential is absent. Fakes
must stay true to the real contract: shapes, error codes, and failure modes.

## 8. AI pipeline and cost metering

AI cost is a product constraint, so each item is analyzed once, as cheaply as possible.

1. **On device (free):** capture guidance, Vision text recognition on tags, barcode detection.
2. **Deterministic server parsing (free):** `@listora/tag-parse` reads RN/CA numbers, UPC/EAN
   (check digit verified), sizes with their system, fiber percentages, country of origin, and
   labeled style numbers from OCR lines and barcode payloads. Every value carries a confidence
   and its source line. Never scrape or call the FTC RN database.
3. **One multimodal call** (Claude Haiku 5.5, low effort, strict JSON schema). It returns
   canonical attributes with per-field confidence and provenance, plus every marketplace
   variant and a labeled price estimate. Typical cost is about $0.0015-0.003 per item.
4. **Escalation** (Sonnet 5.5) only for low confidence, designer or vintage items, or when the
   user taps "Identify harder". It counts against the plan's premium quota.
5. **Analyze once.** There is one `ai_analysis` per photo-set hash and tier (`standard`, plus
   `premium` only after escalation). Edits, repricing, delist, sync, and profit tracking never
   call AI. Bulk work uses the Batch API.
6. **Evaluation.** `npm run eval` scores the parsers, and a provider behind the `EvalProvider`
   interface, on the synthetic tag corpus in `packages/eval/corpus`. It prints per-field
   accuracy, precision, recall, and cost per item, including the billed cost of failed calls.
   The `fake` (default) and `anthropic` providers go through `AiClient`, so the guards, the
   tier's model (`--tier`), and metering are the production ones.
   The parsers must stay at or above 95% on every field (a unit test enforces this). Providers,
   the corpus license manifest, and how to change the corpus are described in
   [packages/eval/corpus/README.md](../packages/eval/corpus/README.md).
7. **Metering from day one.** Every call writes an `ai_usage_event` (tokens, images, searches,
   `cost_micros` from a versioned price table). The system also keeps daily and monthly
   rollups and per-plan quotas in reseller units. There is a per-account daily dollar circuit
   breaker (default $1/day), a global kill switch, and budget alarms.

`@listora/ai` is the provider layer behind steps 3, 4, and 6, and implements step 7's metering
and guards (budget alarms are T-29):

- **`AiClient` is the only way to call AI.** A call names its account, purpose, and tier
  (`standard` is the Fast tier, `premium` the escalation). The client checks the guards in
  order: the global kill switch (`AI_KILL_SWITCH`), the account's spend today in UTC against
  `AI_DAILY_BUDGET_USD`, and the plan quota hook (`QuotaPolicy`, in reseller units such as
  `ai_items`). A tripped guard throws `AiGuardError` before anything is sent and records
  nothing. Quota units are consumed only when a call succeeds.
- **Tiers map to models by configuration** (`AI_MODEL_STANDARD`, `AI_MODEL_PREMIUM`); the
  default registry is Haiku 5.5 at low effort and Sonnet 5.5 at medium effort. Every
  configured model must be in the price table, so every call can be priced.
- **Prices** live in `packages/ai/src/prices.ts` as integer micro-dollars per million tokens.
  A price change adds a new table version; each event stores the version it was priced with.
  Costs round up to the next micro-dollar, once per call.
- **Every call is metered, failed ones too.** The provider reports what it billed (a
  truncated or invalid answer still costs tokens), and the event records it with
  `outcome = 'failed'` and an `error_code` before `AiCallError` is thrown. Providers send one
  request per call and never retry, so each request the vendor sees is its own event. If the
  call's item or user is deleted while it runs, the event is still recorded, without that
  reference.
- **Rollups.** A trigger adds each event to `ai_usage_daily` for its account and UTC day, and
  the daily budget guard reads that row. `UsageStore.monthlyUsage(accountId, 'YYYY-MM')`
  returns an account's totals for a UTC calendar month (cost, calls, failed calls, tokens,
  images, and web searches) by summing the month's daily rows; the table's
  `(account_id, usage_date)` primary key serves that range scan, so there is no separate
  monthly table or index.
- **Timeouts.** `AI_REQUEST_TIMEOUT_MS` defaults to 600000 (the SDK's own default), so long
  Premium calls are not cut off. A timed-out call may still be billed but is metered at zero.
- **Providers.** `FakeAiProvider` answers from fixture JSON keyed by photo-set hash and output
  schema name (`packages/ai/fixtures/README.md`), validates it against the schema, and
  estimates usage the way the API counts it. Fake calls are metered at the configured model's
  real prices so budgets behave the same in development. `AnthropicProvider` uses the official
  SDK with strict structured output (`output_config.format` from the Zod schema), base64
  images, the tier's effort, and a prompt-cache breakpoint on the system prompt. Its live smoke
  test runs only when `ANTHROPIC_API_KEY` is set.

## 9. Data model outline

PostgreSQL, one schema, defined by the SQL migrations in `packages/db/migrations` (T-04).

- **Tenancy.** Every table has a non-null `account_id`, except `account` itself and
  `app_user` (a person's identity is global, and `membership` links it to accounts). Child
  rows reference parents through composite `(account_id, <parent>_id)` foreign keys, so the
  database rejects a row that points at another tenant's data. Deleting an account deletes
  all of its data.
- **Columns.** Ids are `uuidv7()`. Money is `bigint` cents (`*_cents`) plus a `currency`
  column (`currency_code` domain, USD only for now). Status-like columns are text with a
  CHECK of allowed values, mirrored by the lists in `packages/db/src/values.ts`.
- **Timestamps.** `created_at` and `updated_at` default to `now()`, and a trigger maintains
  `updated_at`. The append-only tables (`operation_event`, `audit_log`, `ai_usage_event`) have
  only `created_at`, since their rows never change.
- **History is kept.** A trigger rejects updates and deletes on the append-only tables, and
  deletes on `marketplace_operation`. The only changes it lets through are foreign-key actions
  caused by deleting a parent row (for example deleting the account), never direct statements
  or other triggers. So an operation and its `operation_event` history go away only with the
  account.
- **Invariants in the schema.** An operation can be `succeeded` only with `success_evidence`
  (`read_back` or `user_confirmation`), and `failed` only with a user-readable error. Assisted
  connections can never hold credentials. `inventory_item.version` is bumped by a trigger on
  every update, for optimistic locking.

Tables by area:

- **Tenancy:** `account`, `app_user`, `membership`, and `sku_sequence` (gapless per-account
  SKUs such as `AJ-000184`, allocated by `createInventoryItem` / `allocateSku` in
  `@listora/db` inside the item-create transaction). `sku_prefix` lives on `account`, not on
  `membership` as the plan's data model sketched: SKUs and their counter are per account
  (decision D12), so every member of an account creates SKUs with the same prefix.
- **Inventory:** `inventory_item` (status, canonical attributes, prices, cost,
  `field_provenance`, optimistic-lock `version`), `photo` (role, hashes, derivatives, OCR and
  barcodes), and `storage_location`. `photo` stores pixel `width` and `height` but no byte
  size; the stored object's size is available from object storage when needed.
- **AI:** `ai_analysis` (unique per photo-set hash and tier), `ai_usage_event` (one
  append-only row per provider call, with its tier, outcome, and error code), and
  `ai_usage_daily`, which a trigger on `ai_usage_event` keeps in step per account and UTC day.
  Monthly totals come from `UsageStore.monthlyUsage` (section 8).
- **Marketplaces:** `marketplace_connection` (mode, encrypted tokens, expiry, status),
  `marketplace_listing` (per-marketplace variant, external ids, status, remote snapshot,
  desired/applied version), `marketplace_operation`, and the append-only `operation_event`.
- **Sales and delist:** `inbound_event` (deduplicated per account, source, marketplace, and
  provider event id, so an id that repeats in another account or on another marketplace is
  never dropped as a duplicate). `sale` is one marketplace order (unique per account,
  marketplace, and external order id) with the order-level fields: sold time, currency,
  shipping charged, detection source, status, and ship-by. Its `sale_item` rows are the items
  it sold, one per item (an order can be a bundle), each with its price and, when known, the
  item's listing on the sale's marketplace. `delist_run` is one per sold item and must point
  at an item of its sale; the `delist_run_listing` view lists its operations and user tasks.
  `fee_line` belongs to a sale and optionally to one of its items. Also `user_task` and
  `expense`. Auto-delist operations have `origin = 'auto_delist'` and reference their
  `delist_run`.
- **Pricing:** `pricing_snapshot` (source-labeled).
- **Billing:** `subscription`, `entitlement`, and `usage_counter`.
- **History:** `audit_log` (item changes the user can see).

**Migrations.** Each migration is a pair of plain SQL files, `NNNN_name.up.sql` and
`NNNN_name.down.sql`, run by Kysely's migrator in one transaction with a lock (`npm run
db:migrate`). Never edit a migration that has been merged; add a new one. A schema change
updates the Kysely table types in `packages/db/src/schema.ts` and the value lists in
`values.ts` in the same change; `schema.int.test.ts` fails when they drift. `bigint` columns
read as numbers (throwing above `Number.MAX_SAFE_INTEGER`) and `date` columns as
`YYYY-MM-DD` strings. Write `jsonb` values with `jsonb(value)`.

## 10. Testing and CI

- `npm run check` runs the format check, lint (ESLint and shellcheck), type check, the API
  contract check, unit tests, and integration tests. It must pass before merge. When iOS code
  is touched, `make ios-lint` and `make ios-test` must pass too. `make ios-test` runs the
  package, unit, and UI tests on an existing iPhone 17 simulator and keeps DerivedData in
  `.build/ios`.
- Integration tests use a real Postgres: the local `listora_test` database from
  `scripts/dev-db.sh` (locally and in CI), or `TEST_DATABASE_URL` when set. They fail, and
  never skip, when the database is unreachable. Tests that need their own schema create a
  throwaway database with `createScratchDatabase` from `@listora/testing` and drop it after.
- Tests cover acceptance criteria **and failure paths**. Process-level tests start the real
  entry points with `node src/main.ts` (see `startNodeProcess` in `@listora/testing`).
- **API contract.** `packages/api-contract/openapi.yaml` is the only place an endpoint or
  payload shape is defined. The server imports its types from `@listora/api-contract` and
  the iOS app uses the generated `ListoraAPI` Swift package. `npm run contract:check` lints
  the spec, fails when the committed generated code is stale, and tests the Swift package.
  Its conventions (error model, idempotency keys, pagination, Money) are in
  [packages/api-contract/README.md](../packages/api-contract/README.md).
- CI runs the same fresh-clone path as local development; see the CI section of the
  [README](../README.md#ci). A macOS job runs `make ios-lint` and `make ios-test`, but only
  when a file the iOS build reads changed (macOS minutes cost 10 times Linux minutes); the
  Linux backend check runs on every pull request.

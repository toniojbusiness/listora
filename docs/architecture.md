# Listora architecture

Listora is a mobile-first operating system for resellers: take photos once, create the item
once, and manage it everywhere (eBay, Depop, Poshmark, Mercari). This is the engineering
overview every task reads first. Keep it accurate and short. If your change makes something
here wrong, fix this file in the same PR. The task list is in [roadmap.md](roadmap.md).

## 1. Product invariants

These two rules from the product owner override every other design choice.

1. **Authorized integrations only.** Listora uses official marketplace APIs, authorized
   partner channels, or browser automation the marketplace has permitted (decision D1, section
   4). It never stores marketplace passwords, never solves or bypasses CAPTCHAs or bot checks,
   never works around anti-bot protection, and never automates a marketplace in ways that put a
   seller's account at risk. Where none of these channels is available, or automation meets a
   check it must not pass, Listora uses **assisted mode**: it prepares the work and the user
   does the final step.
2. **Never report false success.** A marketplace action is shown as done only after one of two
   things: a read-back from the marketplace (its API, or the automated browser session)
   confirms the desired state, or the user explicitly confirms an assisted task. Every failure
   is visible and can be retried. See section 6.

## 2. Stack

| Area       | Choice                                                                                          | Why                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| iPhone app | Native Swift 6 / SwiftUI, iOS 18+, XcodeGen, local SPM modules, GRDB                            | Camera, Vision OCR, barcodes, background upload, Share Extension, and StoreKit are native |
| Backend    | TypeScript on Node 26: Fastify API plus a worker process                                        | One language for the API, worker, infra (CDK), and the later web app                      |
| Contract   | OpenAPI 3.1 in `packages/api-contract` → generated TS types and Swift client; CI fails on drift | Client and server cannot drift apart                                                      |
| Database   | PostgreSQL 18 (Homebrew locally, RDS in prod), Kysely, plain SQL migrations                     | Relational inventory, strong constraints, JSONB for marketplace payloads                  |
| Jobs       | Graphile Worker (Postgres-backed), enqueued in the same transaction as the operation row        | No second datastore; an operation can't be recorded without its job, or the reverse       |
| Photos     | Client sends JPEG without GPS; S3 + CloudFront (local-disk driver in dev); `sharp` derivatives  | Marketplaces fetch images by URL; GPS stripping protects privacy                          |
| Auth       | Amazon Cognito (Sign in with Apple, email OTP); dev OTP driver                                  | Managed and in the same AWS account                                                       |
| Billing    | Stripe (web) plus StoreKit 2 (in-app), with entitlements unified on the server                  | App Store rule 3.1.3(b)                                                                   |
| Hosting    | AWS: ECS Fargate, ALB, RDS, S3/CloudFront, SES, KMS, Secrets Manager, CloudWatch; CDK (`infra`) | Standard, robust, one security boundary                                                   |
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

### iOS conventions

The details and commands are in [apps/ios/README.md](../apps/ios/README.md).

- `apps/ios/project.yml` is the only source of the Xcode project. XcodeGen generates
  `Listora.xcodeproj`, which is gitignored and never edited by hand.
- Swift 6 language mode with complete strict concurrency, and warnings are errors.
- Code lives in local Swift packages: `Core` (models and utilities, no UI), `DesignSystem`
  (palette, typography, spacing, components), `APIClient` (the client generated from the
  OpenAPI contract, with the session's bearer token and the error model), and `Features` (one
  library per feature). A feature never imports another
  feature; `AppFeature` composes them into the tab shell. The app target only starts
  `AppFeature`.
- Configuration comes only from the build configuration's xcconfig file (`Dev-Debug`,
  `Staging-Release`, `Prod-Release`) through Info.plist. `AppConfiguration` validates it at
  launch and stops the app with an error that names the bad key. Only Dev may use plain HTTP.
- On-device state the user creates (drafts and their photos) is written to the GRDB database
  first, and work against the server goes through a persistent queue whose every request has a
  stored `Idempotency-Key`, so it resumes after a relaunch without duplicates and shows each
  failure with a Retry. The Add Item upload queue is the model (`apps/ios/README.md`).
- Views use `DesignSystem` tokens, never raw colors or sizes, so light and dark mode stay
  consistent. A test checks WCAG AA contrast for every text and background pair.
- Tests use Swift Testing; UI tests use XCTest. `make ios-lint` (SwiftLint and SwiftFormat)
  must be clean.
- Releases are plain `xcodebuild`, no fastlane: `scripts/ios-release.sh` archives
  (`make ios-archive` unsigned, `make ios-testflight` signed with an App Store Connect team API
  key and uploaded). The hand-dispatched TestFlight workflow runs it; the build number is the
  workflow's run number. Bundle ids and the team id are xcconfig settings.

## 3. Repository layout

```text
apps/
  api/          Fastify HTTP API (@listora/api)
  worker/       Background worker: operation engine, account deletion, polls, health jobs,
                photo processing, item analysis (@listora/worker)
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
                assisted adapters, conformance suite; fake marketplace with fault injection
                (@listora/marketplaces)
  operations/   Operation engine: enqueue, state machine, executor, crash recovery (@listora/operations)
  accounts/     Account lifecycle: deleted identities, the account deletion tombstone and its job,
                Cognito user administration, marketplace grant revocation (@listora/accounts)
  shared/       Types and utilities used by every backend workspace (@listora/shared)
  testing/      Test-only helpers: test DB URL, scratch databases, process harness (@listora/testing)
  tag-parse/    Tag-text parsers: RN/CA, UPC/EAN, size, fiber, origin, style (@listora/tag-parse)
  eval/         Synthetic tag corpus (corpus/) and the eval harness CLI (@listora/eval)
infra/          AWS CDK v2 app: one environment per synth, stacks per lifecycle (@listora/infra)
scripts/
  dev-db.sh     Local PostgreSQL 18 cluster in .local/pg
  container-smoke.sh  Builds the application image and runs it as AWS does (CI)
  ios-release.sh  iOS release archive and TestFlight upload (make ios-archive, ios-testflight)
Dockerfile      Application image; the API and the worker run from the same image
docs/           This overview, the roadmap, and the personal environment's cost estimate
Makefile        iOS commands (make ios-test, ios-lint, ...)
```

New backend libraries go in `packages/<name>` (for example `packages/marketplaces` for
adapters). Add each one to the root
`tsconfig.json` references. Tests sit next to the code: `*.test.ts` files are unit tests with
no external services, and `*.int.test.ts` files are integration tests against the real local
Postgres.

### The API (`apps/api`)

```text
src/
  main.ts        Entry point: config, logger, database, auth driver, graceful shutdown
  app.ts         buildApp(): request ids, error handling, routes (tests drive it with inject)
  config.ts      Environment, parsed once with a zod schema
  errors.ts      ApiError and the contract's ErrorResponse; HTTP status per error code
  contract/      Validators compiled from openapi.yaml, and contractRoute()
  auth/          AuthDriver interface; the dev driver (with its /dev/auth endpoints) and the
                 Cognito driver
  account/       Account deletion (deleteAccount); the job that finishes it is in
                 @listora/accounts
  tenancy.ts     Tenant resolution: the tenancy guard
  idempotency.ts Idempotency-Key handling for POSTs
  items/ photos/ One folder per resource: routes.ts, repository.ts, mapping and views
  analyses/      Start, get, escalate, and apply analyses; the guard pre-check
  uploads/       Upload sessions (createUploadSession, getUploadSession) and the file claim
  storage/       The local storage driver's HTTP routes (signed PUTs, public GETs)
  pricing/       getItemPricing: loads cost, snapshots, and actual fees for @listora/pricing
```

- **Routes come from the contract.** `contractRoute(app, deps, 'createItem', handler)` takes
  the method and URL from `openapi.yaml` by operationId and validates path, query, and body
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
- **Sign-in and account deletion.** `AUTH_DRIVER=dev|cognito`. The Cognito driver verifies
  the pool's tokens locally (cached JWKS, issuer, app client, `token_use`, expiry) and fails
  closed. `DELETE /v1/account` deletes the account's data in one transaction that also leaves
  a tombstone and enqueues its `account_deletion` job, then deletes its stored objects; the
  worker's job deletes the person at the identity provider and revokes marketplace grants,
  retrying until done. The flows, the user pool settings the infrastructure must create, and
  the open items are in [auth.md](auth.md).
- **Idempotency.** A POST runs in one transaction that takes an advisory lock on (account,
  key) and stores its successful response in `idempotency_record` together with the change,
  so a retry replays it, a concurrent retry gets `409`, and a failure stores nothing. Each
  stored response also deletes up to 100 expired records (any account, oldest first, skipping
  rows another request holds), so the table stays about one retention period in size.
- **Errors and logs.** Every error is the contract's `ErrorResponse`; unexpected failures are
  a generic `500 internal_error` and only the log has details. Each request has an id (a
  sane incoming `X-Request-Id`, otherwise a UUID) that is in the response header, in
  `error.requestId`, and as `requestId` on every log line of the request.
- **Writes** that change an item append an `audit_log` entry in the same transaction.
  `fieldProvenance` is server-owned: a detail written through the API is `user`, an unchanged
  one keeps its source (values compare as key-sorted JSON). Responses omit empty values
  (absent means no value).
- **Item status.** Archiving records the item's earlier status in `pre_archive_status`, so
  unarchiving never overwrites a status the server owns (listed, sold, shipped). Which
  transitions the user may make is part of the contract: see `ItemStatus` in `openapi.yaml`.
- **Shutdown.** On SIGTERM the server stops accepting connections, finishes in-flight
  requests (asking their keep-alive clients to close), then closes the database pool.

### Photos and storage (`packages/storage`, `packages/photos`)

- **Upload flow.** `createUploadSession` returns one upload target per declared file (JPEG,
  at most 20 MiB, with its SHA-256). The client PUTs the bytes straight to storage, then
  `addItemPhoto` attaches the file: the server checks that the stored object has the declared
  size and checksum, creates the photo as `processing`, and adds its processing job in the
  same transaction. Targets last 15 minutes (`getUploadSession` returns fresh ones after a
  relaunch); a session lasts 24 hours, and a file is attached at most once.
- **Storage drivers** implement `ObjectStorage`. Both sign the content type, exact size, and
  `x-amz-checksum-sha256` of each upload, so storage itself refuses any other body: S3 with
  presigned PUTs, and the local driver (files in `.local/storage`) with HMAC-signed URLs that
  the API serves under `/storage/`. Keys under `public/` are readable by URL (CloudFront in
  production); every other key is private and never served.
- **Processing** (`processPhoto`, a job function under the task name `photo_processing`)
  verifies the upload's sha256, decodes it with `sharp` (a non-JPEG or broken file makes the
  photo `failed` with a reason the user can read), turns it upright, and writes metadata-free
  sRGB JPEGs: `original` (full size) and `ai` (1024 px) privately, and `thumbnail` (400 px)
  and `listing` (1600 px) under an unguessable public key. It stores their keys, sizes, and
  hashes in `photo.derivatives`, the upright size, and a 64-bit DCT pHash, then deletes the
  upload, which may carry GPS. Every step is safe to rerun. The API adds the job to the job
  queue (Graphile Worker, `graphilePhotoJobs`, job key `photoJobKey`) in the transaction that
  attaches the photo, and the worker runs it (`processPhoto`, task `photo_processing`) next to
  the operation steps. Analyses go the same way (`graphileAnalysisJobs`, `analysisJobKey`,
  `runItemAnalysis`, task `item_analysis`). The API and the worker must share photo storage:
  deployed, both use the S3 photo bucket (`infra/src/containers.ts`). Photo and analysis jobs
  run in a pool of their own (`WORKER_TASK_CONCURRENCY`), so a slow AI call never holds a
  slot an operation step, such as an urgent delist, needs.
- **Photo-set hash.** `itemPhotoSet` returns an item's photos in order and `photoSetHash`
  (from `@listora/shared`) over their upload sha256s, the key analysis is idempotent by. The
  hash sorts the sha256s, so reordering the photos or choosing another cover keeps the
  analysis; only adding or removing photos makes a new photo set. The display order reaches
  only the prompt.
- Deleting a photo, its item, or the whole account deletes its stored objects after the transaction commits.

## 4. Marketplace adapter model

All marketplace logic lives behind one `MarketplaceAdapter` interface in `@listora/marketplaces`
(`adapter.ts`). The engine and the UI never branch on the marketplace name. They branch on
**capability flags**, which can change for a single connection; for example, Depop runs
assisted until its partner API is connected, then through the API.

```ts
type Mode = 'api' | 'assisted' | 'bulk_file' | 'none';
interface MarketplaceCapabilities {
  connect: 'oauth' | 'none';
  create: Mode;
  updatePrice: Mode;
  updateDetails: Mode;
  delist: Mode;
  relist: Mode;
  markSold: Mode | 'not_needed'; // not_needed: the marketplace marks its own sales sold
  verifyRead: 'api' | 'user_confirm'; // how success is established
  readFreshness: 'revision' | 'none'; // whether reads carry a revision (see section 6)
  importListings: 'api' | 'share_sheet' | 'bulk_file' | 'none';
  saleDetection: Array<'webhook' | 'poll' | 'email' | 'manual'>;
  imageTransport: 'url_fetch' | 'upload' | 'user_saves_photos';
  taxonomy: 'api' | 'static_snapshot';
  pricingData: 'sold_comps_in_listing_context' | 'none';
  externalSkuReusable: boolean; // Depop: false
  limits: { perSellerPerMin?: number; appPerMin?: number; appPerDay?: number };
}
interface MarketplaceAdapter<P extends ListingPayload = ListingPayload> {
  id: 'ebay' | 'depop' | 'poshmark' | 'mercari';
  capabilities(connection?: ConnectionRef | null): MarketplaceCapabilities;
  buildPayload(item: ItemSnapshot, variant: ListingVariant, connection: ConnectionRef | null): P; // pure
  validate(payload: P, connection: ConnectionRef | null): ValidationIssue[]; // pure
  execute(op: OperationRequest<P>, ctx: AdapterContext): Promise<Outcome>;
  // Outcome: confirmed | rejected | transient | unknown | pendingUser
  readListing(ref: ListingRef, ctx: AdapterContext): Promise<RemoteListingState>;
  healthCheck(ctx: AdapterContext): Promise<Health>; // ok | degraded | reauth_required | revoked
}
```

Imports, orders, webhooks, emails, and credential refresh join the interface as optional
members with the tasks that first use them (T-16, T-17, T-23, T-36).

| Marketplace | Mode                                                                         | Listing lifecycle                                                                                                                          | Sale detection                                                  |
| ----------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| eBay        | API                                                                          | Trading API Add/Revise/End/Relist (keeps listings editable in Seller Hub); Media, Taxonomy, Fulfillment REST APIs                          | `ORDER_CONFIRMATION` webhook + 5-minute poll                    |
| Depop       | API after partner approval; browser automation until then, assisted fallback | `PUT` by per-attempt external SKU, `PATCH`, `DELETE`/mark-as-sold; verify with `GET`                                                       | `v1:order.*` webhooks + poll                                    |
| Poshmark    | Browser automation (permitted by Poshmark), assisted fallback                | The runner acts in the seller's session and reads the listing back; fallback: copy-assist, photos saved in order, deep link, user confirms | DKIM-verified forwarded emails, scheduled browser check, manual |
| Mercari     | Browser automation (permitted; no public API), assisted fallback             | Same as Poshmark                                                                                                                           | Forwarded emails, scheduled browser check, manual               |

**Capabilities route every operation.** `operationMode(capabilities, kind)` (`capabilities.ts`)
reads the flag for the kind (`create`, `updateDetails` for a revise, `updatePrice`, `delist` for
an end, `relist`, `markSold`) under the listing's connection: `api` (Listora sends it and a
read-back decides), `assisted` (only the user's confirmation finishes it), or `unsupported`
(`none`, `bulk_file`, `not_needed`, or an API write without API reads), which fails without
being sent. `checkCapabilities` rejects contradictory flags, such as an API write with
`verifyRead: 'user_confirm'`.

**Registry.** `createAdapterRegistry` (`registry.ts`) holds one adapter per marketplace and
refuses, at startup, a duplicate or an adapter whose capabilities are incoherent without a
connection or under either connection mode. The worker passes its `lookup` to the engine
(`apps/worker/src/adapters.ts`), and the API asks it for capabilities under a connection.

**Listing content and payloads.** A create, revise, or relist publishes listing content
(`content.ts`): an `ItemSnapshot` (canonical attributes and photos with their listing URLs) and
the marketplace's `ListingVariant` (title, description, price, category, condition, aspects,
hashtags), mirroring the API contract. `enqueueOperation` stores it on the operation and derives
the operation's desired state from it (`desiredStateForContent`), so what is sent and what a
read-back checks cannot disagree. Every attempt builds the payload from that stored content
with the adapter's pure `buildPayload`, under the connection it runs with, so a queued item edit
never changes an operation in flight. The engine sends nothing the adapter's `validate` refuses:
the operation fails with the first issue's message (for example "eBay titles can be at most 80
characters.") and every issue in its history. Builders sort photos by `position` and never trust
the input order. Each adapter's payload, validation results, and assisted tasks are pinned by
golden files in its `__golden__` directory; `npx vitest -u` rewrites them after a deliberate
change, and the diff is reviewed like code.

**Execute and read-back rules.** `execute` never throws for a marketplace error; it returns an
outcome. A rate limit is `transient` with the marketplace's `Retry-After`, a 5xx is `transient`
(even when it hid an applied write, which the next attempt's read-back finds), validation and
expired authorization (`reauth_required`) are `rejected`, a timeout after sending is `unknown`,
and ending an ended listing is `confirmed` so that a read-back decides. `readListing` throws when
the marketplace cannot be read (5xx, 429, auth error, unreachable), and must find the effect of
an earlier attempt even when that attempt's outcome was unknown (by external id or SKU).
When it finds no listing, it says whether that is `authoritative`: only when the marketplace
definitively reports that the listing with the requested id no longer exists (a "removed" or
410 Gone answer for that id), never for an answer that could be a listing not visible yet (a
plain 404 from an eventually consistent API), an empty SKU search, a timeout, an auth error, or
another unclear answer.

Reads may be stale (eventually consistent APIs), so a read carries a freshness marker: a
`revision`, a non-negative integer that grows with every change to the marketplace listing (a
remote revision, or a last-modified time in milliseconds that differs for every change). A
`confirmed` outcome also returns the revision the write produced, when the marketplace says. An
adapter whose marketplace has no such marker declares `readFreshness: 'none'` and returns
`revision: null`.

**Assisted adapters.** `AssistedAdapter` (`assisted/assisted-adapter.ts`) is the base for
assisted mode. `createPoshmarkAdapter`, `createMercariAdapter`, and `createDepopAssistedAdapter`
configure it: those marketplaces run on it until the browser runner (decision D1, below) or
Depop's partner API takes over, and it stays their fallback when automation meets a check it
must not pass. `execute` never contacts the marketplace: it returns
`pendingUser` with a user task, `list_manually` (create, relist), `edit_manually` (revise,
price), or `delist_manually` (end), with a deep link and a copy-assist payload (title,
description, price, and photo URLs in posting order). The engine records the task in the same
transaction as the `needs_user_action` status, and only `confirmOperationByUser` can finish the
operation. Assisted capabilities establish success by `user_confirm`, `readListing` always
throws, and the engine never reads back an assisted operation, so no read can ever confirm one.
New listings open the marketplace's site; changes open the listing's own page once the user has
linked it, and only when that URL is an https page on the marketplace's own domain. Deeper app
links and the Poshmark and Mercari text limits are not verified yet (plan RF15), so the base
enforces only a positive price and at least one photo for them.

**Connection-aware capabilities.** `ConnectionAwareAdapter` serves one marketplace in more than
one mode: its assisted adapter without a connection or under an assisted one, and its API adapter
under an `api` connection (still assisted when no API adapter is configured). Every mode reads
and writes the same `marketplace_listing` rows, so switching Depop to the API is a change to the
connection's `mode` and needs no data migration. The browser runner's mode joins it the same way
when that task lands.

**Conformance.** Every adapter passes the shared suite in `conformance/suite.ts`
(`describeAdapterConformance`), once per connection mode it serves, against its own fake
marketplace: coherent capabilities, pure golden-tested payloads and validation, create, price
and detail updates, end (twice), relist, mark sold, read-back by SKU and id with freshness,
stale reads, not-found classification, error mapping (429 with and without `Retry-After`, 5xx
before and after the change, validation, expired authorization, timeout after send,
unreachable), failing reads that throw, health checks, and, for assisted kinds, user tasks that
never touch the network and never confirm themselves. A new marketplace fake must be able to
produce each failure mode the suite asks for (`ConformanceMarketplace`).

**Decision D1, revised 2026-10-24.** D1 (the Poshmark and Mercari posture) was "assisted
only". The marketplaces granted the product owner permission to automate where no API exists,
Listora is for the product owner's personal use, and everything runs in the cloud. So
Poshmark, Mercari, and Depop (until its partner API is granted) use cloud browser automation:
the headless-Chromium browser runner (`browserRunner` in `infra/src/config.ts`) acts on
sessions the user logs into from the iPhone app.

- Session cookies are stored encrypted with the token key, by the same KMS envelope
  encryption as OAuth tokens. Passwords never are.
- Actions are human-paced.
- The runner never solves or bypasses a CAPTCHA or bot check: it pauses and falls back to an
  assisted task.
- Every action is still confirmed by read-back (section 6), never reported as a false success.

The runner, its adapter mode, and session storage are later tasks; until they land, these
marketplaces run assisted. [costs.md](costs.md#browser-automation) sizes and prices the runner.

## 5. Pricing data rules

The eBay API License forbids using eBay data to suggest prices without written consent. The
Depop rules allow Pricing Inspiration only inside that Depop listing. Without real sold data,
Listora shows a cost-based floor, an estimate labeled **"AI estimate - not based on sold
listings"**, and research links that open in the user's browser. The words "comps" and "sold"
appear only next to real sold data, and a test enforces this (T-14).

`@listora/pricing` implements these rules; `GET /v1/items/{itemId}/pricing` serves them.

- **Floor** ("Don't sell below"), per marketplace: the least price P with P = cost + fees(P) +
  shipping + minimum profit, so the breakdown adds up exactly. Shipping and minimum profit are
  query parameters (default 0). No cost means no floors.
- **Fee tables** live in `packages/pricing/src/fee-tables.ts`, one versioned table per
  marketplace schedule with its official source URL and the day it was checked. A fee change
  adds a table; every floor names its `feeTableVersion`. Estimates use the item price only and
  round each fee up. A test checks that every table's fees never fall as the price rises.
- **Actual fees.** With at least three recent single-item sales that have `actual` marketplace
  or payment `fee_line`s, a marketplace's table is scaled to what it really charged
  (`feeSource: actual_fees`). Each sale is compared with the fee table in effect on its
  `sold_at` (the marketplace's first table for older sales), so a fee change is never masked
  by sales at the old rate. A sale counts only when its fee data is complete: an `actual`
  line for every fee kind the table charges, and no zero-amount or refunded (negative) line.
  Ratios of actual to estimated fees outside 1/3 to 3 point at bad order data and are not
  used. eBay-sourced fee data (including the eBay Finances API) stays out of eBay floor
  computation until a legal review of the eBay API License (red flag RF3) says otherwise, so
  eBay floors use the published table; `ORDER_DATA_MAY_ADJUST_FEES.ebay` is the one switch
  to flip after that review.
- **Tiers** (quick sale, recommended, higher profit) are the AI estimate's low, mid, and high,
  each raised to the highest floor when below it, and labeled "(AI estimate)" or "(cost
  floor)". Sold data is shown as `soldComparables` but never sets a tier.
- **Snapshots.** `pricing_snapshot` holds source-labeled price data, validated against its
  source's payload schema on write and on read (a malformed row is skipped and logged). The
  estimate of the item's current analysis (the accepted one, else the latest succeeded) is
  recorded as one `ai_estimate` snapshot per analysis; it is read from the analysis output's
  `priceEstimate` (the contract's `AnalysisResult` shape). Sold data snapshots are shown while
  unexpired, the latest per source and marketplace context. Sources bound to one listing
  context must name it (`depop_inspiration` carries `marketplace: depop`, `ebay_mi` carries
  `ebay`), on write, on read, and in the label guard, so clients can show Depop Pricing
  Inspiration on the Depop listing only.
- **Label guard.** `buildPricingSuggestion` runs `labelGuardViolations` on every suggestion
  and throws instead of returning one that breaks the rules, so the API answers `500` rather
  than mislabeling a price.

## 6. Operation engine: never false success

Every marketplace write is a `marketplace_operation` row whose state machine the worker drives
(`@listora/operations`; the state diagram is in `state-machine.ts`).

1. **Write path.** The API, or the auto-delist orchestrator, calls `enqueueOperation`. It
   inserts the operation (`queued`, `idempotency_key`, desired-state snapshot, and for a
   create, revise, or relist its listing content) and enqueues its Graphile Worker job **in
   the same transaction**. Enqueueing the same key again returns the existing operation. The
   desired state names the fields a read-back must show, so an empty one is refused; for a
   content operation it comes from the content (section 4).
2. **Execution.** One job runs one step. A step commits `running` before it can send anything,
   so a step cut short is detectable afterwards. No transaction stays open during a
   marketplace call, and a step records its result only if the operation is still exactly as
   the step found it. Jobs run one at a time per listing (`queue_name = listing:<id>`,
   `job_key = operation:<id>`), and a newer operation waits until every older one on its
   listing is finished, so changes apply in order even while an older one waits to retry. A
   daily job deletes listing queues that have no jobs left. Each step runs in the operation's
   capability mode under the listing's connection (`operationMode`, section 4): an
   `unsupported` operation fails without being sent, and a send builds its payload from the
   stored content and fails without sending when the adapter's validation refuses it. The
   adapter outcome determines the next state:
   - `confirmed`: the API succeeded **and** `readListing` shows the desired state → `succeeded`.
     A read-back that disagrees or fails → `verifying`.
   - `rejected` (validation or permanent error) → `failed`, with a user-readable reason and fix.
   - `transient` (429, 5xx, network failure before send) → `retrying` with backoff and jitter
     (30 s, 2 m, 10 m, 30 m, 2 h, 6 h, ±20%, at least the marketplace's `Retry-After`), then
     `failed` with a Retry action.
   - `unknown` (timeout after the request may have been sent, a lost connection, an adapter that
     throws or misses its deadline) → `verifying`. `readListing` decides: the desired state
     holds → `succeeded`; it does not → `retrying`. The request is never re-sent blindly.
   - `pendingUser` (assisted) → `needs_user_action` until the user confirms
     (`confirmOperationByUser`). An assisted operation is never read back, and any other
     outcome for it (`confirmed`, `unknown`) fails as unconfirmed; an API operation that answers
     with a user task fails the same way.
3. **Attempts.** Every step, a send or a read-back, uses one attempt, and an operation gets
   seven. A step whose result is unknown is always followed by a read-back, even after the
   last attempt. Retry (`retryOperation`) gives a failed operation a fresh set of attempts; it
   is refused once a newer operation exists on the listing, since it would undo that one.
4. **Idempotent re-execution.** An operation that was sent before is read back before every
   later send, and succeeds without sending again when the change already took effect (a 5xx
   can hide an applied write). Adapters also pass the operation's idempotency key to the
   marketplace's own duplicate protection where it has one.
   **Pending listing ids.** A listing id a send returns (eBay's `RelistItem` issues a new one)
   is stored at once, in the transaction that records the step, as the listing's
   `pending_external_listing_id`: unverified, and never linked to another listing of the
   account. Every later step and operation on the listing targets the newest known id, the
   pending one over the verified one, so a new listing is never lost even when its read-backs
   fail. A read-back that confirms it promotes it to `external_listing_id`. An end on a listing
   with both ids targets both, since either may be live, and succeeds only when each reads
   back ended under the freshness rule (`confirmEveryReadBack` joins the proofs) or is
   authoritatively absent. **Absent listings.** The goal of an end or mark-sold is that nothing
   is live, so an authoritative not-found satisfies its target (eBay drops ended listings
   after a while): a refused end is read back before it fails, a precheck that finds the id
   absent sends nothing to it, and on success the absent id is retired from the listing row. A
   create, relist, or edit is never confirmed by an absence.
5. **Read freshness.** A stale read can show an older state that happens to match (after end,
   relist, end, the first end), so a read-back confirms only when it is current
   (`confirmByReadBack` in `evidence.ts`, the only maker of read-back proofs). Listora keeps the
   newest revision it has seen of each marketplace listing, from reads and confirmed sends,
   including the revision a send was confirmed with, so the rule survives a crash:
   `marketplace_listing.remote_revision` for the verified id and `pending_remote_revision` for
   the pending one. A read older than that revision is stale and decides nothing,
   neither success nor a resend; another read follows after the backoff delay. With
   `readFreshness: 'none'`, a matching read confirms only when the operation's previous read, a
   delay earlier and with no send in between, matched too (the operation waits in `verifying`
   with code `confirming`). That assumes staleness lasts less than the delay; adapters should
   provide a revision wherever the marketplace has one.
6. **Crash recovery.** Each worker holds a Postgres session named `listora-worker:<pool id>`,
   which the operating system closes when the process dies, even on SIGKILL. Live workers
   release the job locks of pools that have no session within about 10 seconds (Graphile
   Worker alone waits 4 hours). The job runs again, finds its step `running`, and reads the
   listing back. A worker that loses its own session exits at once. So every Graphile Worker
   runner must be started through `startOperationWorker`, with the same database role, on a
   direct connection (not a transaction pooler).
7. **Listing truth.** A verified success records what the marketplace showed on the
   `marketplace_listing`: status, external id and URL (a confirmed pending id becomes the
   external id), `remote_snapshot` (with its revision), `remote_revision`, `last_verified_at`.
   A user confirmation changes only the status.
8. **History.** Every transition appends an `operation_event` with a redacted request/response
   excerpt (`redactForStorage` in `@listora/shared`), error code, and attempt number.
9. **Invariant, enforced in code and tests:** no code path sets `succeeded` without a verified
   read-back or a user confirmation event. `transitionOperation` is the only code that writes
   operation rows, and it sets `succeeded` only with a `SuccessProof`, which only `evidence.ts`
   can create, and only for a current read; a test scans the code for any other writer. Chaos
   tests inject 429s, 5xx errors (also after the change was applied), timeouts after send,
   stale reads, and a worker killed mid-operation, over listings that are ended and relisted
   more than once.
10. **Concurrency (T-16, T-24).** Token refresh is single-flight per connection; Depop rotates
    refresh tokens, so a lost write disconnects the seller. Rate limits use per-seller and
    app-wide token buckets.

**Auto-delist.** A sale event (webhook, poll, email, or manual entry) is deduplicated by
its order (see `sale` in section 9). Then, in one transaction, Listora records the sale, sets
the item to `sold_pending_delist`, and creates a high-priority delist operation or urgent
assisted task for every other listing. A `delist_run` gathers the per-marketplace results. If
anything is still unconfirmed after 10 minutes, Listora alerts the user again, and after 30
minutes it escalates the alert. A second sale opens a double-sale incident.

**Status vocabulary** shown to users: `Active (confirmed by eBay)`, `Delisting... retry 2 of 6`,
`Delist failed - Retry`, `Checking...`, `Action needed - delist on Poshmark`,
`Done (you confirmed)`. Assisted listings never show "confirmed by <marketplace>".
`describeListingStatus` (`status-display.ts`) renders these labels from the listing's newest
operation: "confirmed by <marketplace>" only for a read-back's evidence, "you confirmed" only
for the user's confirmation, and a listing without a successful operation is never shown as
confirmed. The API serves them as `statusDisplay` (T-19).

## 7. Local development: fakes and environment switches

Nothing requires a real credential to build or test. Every external service sits behind an
interface with a fake or dev driver, selected by an environment variable. Each switch below
lands with the task that introduces that dependency, and its keys are added to `.env.example`.

| Dependency       | Dev/test                                                                                                     | Production                 | Switch                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------ |
| Postgres         | `scripts/dev-db.sh` cluster in `.local/pg`                                                                   | RDS                        | `DATABASE_URL`, `TEST_DATABASE_URL`  |
| Marketplaces     | Fake marketplace with fault injection (`@listora/marketplaces`, `npm run dev:fake-marketplace`)              | Real adapters (T-15, T-24) | `FAKE_MARKETPLACE_URL`               |
| Assisted         | Poshmark, Mercari, and Depop run as assisted adapters until the browser runner (D1) or Depop's API lands     | The same                   | none                                 |
| Storage          | Local-disk driver in `.local/storage`, with signed upload URLs served by the API                             | S3 + CloudFront            | `STORAGE_DRIVER=local\|s3`           |
| AI               | `FakeAiProvider` (fixtures keyed by photo-set hash)                                                          | Anthropic API              | `AI_PROVIDER=fake\|anthropic`        |
| eBay             | `fake-ebay` server (Trading XML subset, Media, Taxonomy, Fulfillment, signed notifications, fault injection) | Sandbox, then production   | `EBAY_ENV=fake\|sandbox\|production` |
| Depop            | `fake-depop` generated from Depop's OpenAPI spec                                                             | Sandbox, then production   | `DEPOP_ENV`                          |
| Email ingest     | Folder drop `.local/inbox/*.eml` + `POST /dev/email`                                                         | SES inbound                | `EMAIL_INGEST=folder\|ses`           |
| Auth             | Dev OTP printed to the API log (`POST /dev/auth/codes`, then `/dev/auth/sessions`)                           | Cognito                    | `AUTH_DRIVER=dev\|cognito`           |
| Payments         | Fake Stripe client + StoreKit configuration file                                                             | Stripe, App Store          | `BILLING_DRIVER=fake\|stripe`        |
| Push             | Recording fake                                                                                               | APNs                       | `PUSH_DRIVER`                        |
| Token encryption | Local AES-GCM key from `.env`                                                                                | KMS envelope encryption    | `TOKEN_KMS_KEY_ID`                   |
| iOS              | iPhone 17 simulator, photo-library fixtures                                                                  | Device / TestFlight        | xcconfig `API_BASE_URL`              |

Live smoke tests for real providers skip automatically when their credential is absent. Fakes
must stay true to the real contract: shapes, error codes, and failure modes.

## 8. AI pipeline and cost metering

AI cost is a product constraint, so each item is analyzed once, as cheaply as possible.

1. **On device (free):** capture guidance, Vision text recognition on tags, barcode detection.
2. **Deterministic server parsing (free):** `@listora/tag-parse` reads RN/CA numbers, UPC/EAN
   (check digit verified), sizes with their system, fiber percentages, country of origin, and
   labeled style numbers from OCR lines and barcode payloads. Every value carries a confidence
   and its source line. Never scrape or call the FTC RN database.
3. **One multimodal call** (Claude Haiku 5.5, low effort, a JSON schema every answer is
   validated against; not strict structured output, see the deviation below). It returns
   canonical attributes with per-field confidence and provenance, plus every marketplace
   variant and a labeled price estimate. Typical cost is about $0.0015-0.003 per item.
4. **Escalation** (Sonnet 5.5) only for low confidence, designer or vintage items, or when the
   user taps "Identify harder". It counts against the plan's premium quota.
5. **Analyze once.** There is one `ai_analysis` per item, photo-set hash, and tier
   (`standard`, plus `premium` only after escalation). Edits, repricing, delist, sync, and
   profit tracking never call AI. Bulk work uses the Batch API.
6. **Evaluation.** `npm run eval` scores the parsers, and providers behind the `EvalProvider`
   interface, on the synthetic tag corpus in `packages/eval/corpus`: AI tag reading, and the
   full production analysis (`analyzeItem`), scored on the tag facts it reports. It prints
   per-field accuracy, precision, recall, and cost per item, including the billed cost of
   failed calls.
   The `fake` (default) and `anthropic` providers go through `AiClient`, so the guards, the
   tier's model (`--tier`), and metering are the production ones.
   The parsers must stay at or above 95% on every field (a unit test enforces this). Providers,
   the corpus license manifest, and how to change the corpus are described in
   [packages/eval/corpus/README.md](../packages/eval/corpus/README.md).
7. **Metering from day one.** Every call writes an `ai_usage_event` (tokens, images, searches,
   `cost_micros` from a versioned price table). The system also keeps daily and monthly
   rollups and per-plan quotas in reseller units. There is a per-account daily dollar circuit
   breaker (default $1/day), a global kill switch, per-account blocks, and spend alerts.

`@listora/analysis` implements steps 3 to 5 on top of `@listora/ai`:

- **Request.** `startItemAnalysis` needs every photo of the item `ready` (the photo set is all
  of them) and returns the existing analysis of the photo set when there is one; a `failed`
  one is queued again, since asking again is the retry. Before anything is queued, the API
  runs the AI guards (`AiClient.checkGuards`) with the tier's plan unit, so a request that
  would be refused gets `503` (kill switch), `429` (daily budget), or `402` (quota) instead.
  The row and its job commit together (`requestAnalysis`).
- **The call.** `analyzeItem` sends at most 5 photos' `ai` derivatives (the first tag photo
  wherever it is, then the others in display order) and at most one tag crop: a 784 px
  centered crop of that tag photo when it is sharper than the `ai` image (`tagCrop` in
  `@listora/photos`). Those caps (`MAX_ANALYSIS_PHOTOS`, `MAX_TAG_CROPS` in `input.ts`) are the
  plan's cost basis (3-5 photos and one tag crop per call), which the plan limits and the
  daily circuit breaker were sized for. The prompt is JSON with the phone's OCR lines and
  barcodes and the `@listora/tag-parse` facts. The system prompt holds every rule and the
  canonical vocabulary (`vocabulary.ts`: category tree, departments, colors, patterns,
  materials, size systems, conditions) and nothing per item, so it caches. The answer's
  schema (`itemAnalysisSchema`) also enforces each marketplace's copy limits
  (`marketplace-copy.ts`, with their sources) and cross-field rules; an answer that breaks it
  is `invalid_output`, retried once, then the analysis fails with a reason the user sees.
  The answer is flat (details as plain values, empty when not found, with their confidences
  in a parallel object; decoded before use), and its schema travels in the system prompt
  (`enforcement: 'prompt'`).
- **Deviation from the plan: no strict structured output.** Plan section 5.1 calls for
  structured output with a strict JSON schema (constrained decoding). In the live runs
  Anthropic refused this schema as a strict grammar ("compiled grammar is too large"), even
  after flattening it, so strict mode is not possible for it. The adopted fallback: the full
  JSON schema in the cached system prompt, every answer validated against the Zod schema
  (`itemAnalysisSchema`), and one retry of an answer that breaks it. The cost is an
  occasional billed `invalid_output` retry, and a visible failure after a second bad answer;
  an invalid answer is never stored.
- **Provenance** is the server's: a value is `ocr` or `barcode` only when the phone's reads
  contain it, otherwise `ai`. A confident parsed fact the model agrees with gives its source;
  one the model left out fills the value in; one it contradicts caps the value's confidence
  at 0.5 so the review screen highlights it.
- **Escalation.** A standard result asks for the premium identification when its brand or
  product is uncertain (confidence below 0.6), the item looks designer or vintage, or the
  model says so. With `AI_AUTO_ESCALATE=on` the job then queues the premium analysis (same
  photos plus the first result) in the transaction that stores the result, when the premium
  quota allows; otherwise the user starts it (`escalateAnalysis`). A brand the model did not
  identify at all also sets `needsEscalation` (with the reason "The brand was not
  identified."), so the app makes "Identify harder" prominent, but never escalates on its own:
  many items are unbranded, and a premium identification costs the user's quota. A missing
  product name alone sets nothing, since most secondhand items show none.
- **Quotas.** A standard call uses one `ai_items` unit and a premium call one
  `premium_identifications` unit when it succeeds. `PostgresQuotaPolicy` counts them in
  `usage_counter` per UTC month and enforces the row's `quota` (null means unlimited until
  billing, T-28, sets plan limits).
- **Applying.** `applyAnalysis` copies the proposals into the item with their provenance and
  sets `acceptedAnalysisId`, never overwriting a detail whose provenance is `user`. A later
  `replaceItem` value equal to the accepted analysis's proposal keeps the analysis's source.
- **The job** (`runItemAnalysis`, task `item_analysis`, run by the worker) records every
  outcome on the row, unexpected errors included (`internal_error`, retryable), so an
  analysis never stays `running` or claims a result it does not have: a failed one shows its
  reason and whether asking again may help. Only a database outage while recording throws;
  the queue then runs the job again with backoff.

`@listora/ai` is the provider layer behind steps 3, 4, and 6, and implements step 7's metering,
guards, cost reports, and spend check:

- **`AiClient` is the only way to call AI.** A call names its account, purpose, and tier
  (`standard` is the Fast tier, `premium` the escalation). The client checks the guards in
  order: the global kill switch (`AI_KILL_SWITCH`, or the operator's switch in Postgres), an
  operator's block on the account, the account's spend today in UTC against
  `AI_DAILY_BUDGET_USD`, and the plan quota hook (`QuotaPolicy`, in reseller units such as
  `ai_items`). `createAiClient` adds the operator controls when given `PostgresAiControls`. A
  tripped guard throws `AiGuardError` before anything is sent and records nothing. Quota units
  are consumed only when a call succeeds.
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
- **Operator controls.** `PostgresAiControls` keeps the global kill switch (`ai_kill_switch`,
  one row) and per-account blocks (`ai_account_block`) in Postgres. The client asks them on
  every call, so a change takes effect on the next call in every process, with no deploy.
  Operators change them only through `npm run admin -- ai-kill-switch on|off` and
  `ai-block on|off <account>`, which require `--actor` and `--reason`. Each change and its
  `ai_control_audit` row commit in one transaction, and a request that changes nothing
  (switching on a switch that is already on) records nothing. `AI_KILL_SWITCH=on` stays as a
  deploy-time switch: either one refuses calls.
- **Cost reports.** `npm run admin -- ai-cost ...` reports, for a UTC day or month: top
  accounts by spend and one account's usage (from `ai_usage_daily`, and for one account's month
  from `UsageStore.monthlyUsage`), AI cost per item worked on, and spend by purpose, tier, and
  model (from `ai_usage_event`). An item's cost includes its failed calls and escalations.
- **Spend check.** `checkAiSpend` (run once with `npm run admin -- ai-alerts check`; the worker
  will schedule it) flags accounts approaching (`AI_ALERT_WARN_PERCENT`, default 80%) or over
  the daily circuit breaker or an AI plan quota in `usage_counter`, and all accounts together
  approaching or over `AI_GLOBAL_DAILY_ALERT_USD` per UTC day. It only reads. It logs one
  `event: "ai_spend_alert"` line per alert (warn when approaching, error when over) and one
  `event: "ai_spend_check"` summary with numeric counts. CloudWatch metric filters and alarms
  (T-30, T-32) key on these field names, so they change only together with the alarms. Alerts
  name accounts by id only.
- **Timeouts.** `AI_REQUEST_TIMEOUT_MS` defaults to 600000 (the SDK's own default), so long
  Premium calls are not cut off. A timed-out call may still be billed but is metered at zero.
- **Providers.** `FakeAiProvider` answers from fixture JSON keyed by the request's
  `photoSetHash` (the item's `ai_analysis.photo_set_hash`, not a hash of the images sent) and
  output schema name (`packages/ai/fixtures/README.md`), validates it against the schema, and
  estimates usage the way the API counts it. Fake calls are metered at the configured model's
  real prices so budgets behave the same in development. `AnthropicProvider` uses the official
  SDK with strict structured output (`output_config.format` from the Zod schema; an output
  with `enforcement: 'prompt'` sends the JSON schema as system instructions instead), base64
  images, the tier's effort, and a prompt-cache breakpoint on the system prompt. Its live smoke
  test runs only when `ANTHROPIC_API_KEY` is set.

## 9. Data model outline

PostgreSQL, one schema, defined by the SQL migrations in `packages/db/migrations` (T-04).

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

Tables by area:

- **Tenancy:** `account`, `app_user`, `membership`, and `sku_sequence` (gapless per-account
  SKUs such as `AJ-000184`, allocated by `createInventoryItem` / `allocateSku` in
  `@listora/db` inside the item-create transaction). `sku_prefix` lives on `account`, not on
  `membership` as the plan's data model sketched: SKUs and their counter are per account
  (decision D12), so every member of an account creates SKUs with the same prefix.
- **Inventory:** `inventory_item` (status, canonical attributes, prices, cost,
  `field_provenance`, optimistic-lock `version`, and `pre_archive_status`, the status an
  archived item had before it was archived), `photo` (role, status, failure reason, hashes,
  derivatives, OCR and barcodes), and `storage_location`. `photo` stores the upright pixel
  `width` and `height`; each entry of `derivatives` records its key, size, byte size, and
  sha256.
- **Uploads:** `upload_session` (expiry) and its `upload_file` rows (declared type, size,
  sha256, storage key, and status `pending`, `uploaded`, or `attached`).
- **AI:** `ai_analysis` (unique per item, photo-set hash, and tier; a `premium` one names the
  standard analysis it escalates; a failed one records whether retrying may help),
  `ai_usage_event` (one
  append-only row per provider call, with its tier, outcome, and error code), and
  `ai_usage_daily`, which a trigger on `ai_usage_event` keeps in step per account and UTC day.
  Monthly totals come from `UsageStore.monthlyUsage` (section 8). The operator controls are
  `ai_kill_switch`, `ai_account_block`, and the append-only `ai_control_audit`.
- **Marketplaces:** `marketplace_connection` (mode, encrypted tokens, expiry, status),
  `marketplace_listing` (per-marketplace variant, external ids, status, remote snapshot and
  newest seen revision, desired/applied version), `marketplace_operation` (with the listing
  `content` a create, revise, or relist publishes), and the append-only `operation_event`.
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
- **Pricing:** `pricing_snapshot` (source-labeled; payloads per source in
  `@listora/pricing`, see section 5).
- **Billing:** `subscription`, `entitlement`, and `usage_counter`.
- **History:** `audit_log` (item changes the user can see).
- **API:** `idempotency_record` (the stored first successful response per account and
  `Idempotency-Key`, kept 24 hours; written once, so it has no `updated_at`, and deleted in
  batches by later POSTs once expired), and `deleted_identity` (the SHA-256 of each identity
  whose account was deleted and when, so its earlier tokens are refused; its only timestamp
  is `deleted_at`, and later deletions purge rows older than 48 hours).
- **Account deletion:** `account_deletion` (the tombstone of a committed deletion whose job
  has not finished: the identity's SHA-256 and provider username, attempts) and
  `account_deletion_grant` (the deleted account's marketplace grants still to revoke, with
  their encrypted tokens only while pending). The job deletes the tombstone when it is done.

**Migrations.** Each migration is a pair of plain SQL files, `NNNN_name.up.sql` and
`NNNN_name.down.sql`, run by Kysely's migrator in one transaction with a lock (`npm run
db:migrate`; in AWS, the deploy runs them before new code starts, see section 10). Never edit
a migration that has been merged; add a new one. Numbers must be unique and are never
reused, but gaps are allowed: take the number firstmate assigns, or else the next free one
on `origin/main`, and keep it. Merge migration-bearing branches in numeric order, because
the migrator refuses to apply a migration that sorts before one already applied (Kysely's
default; it is never turned off); `migrations.test.ts` checks the numbering. A schema change
updates the Kysely table types in `packages/db/src/schema.ts` and the value lists in
`values.ts` in the same change; `schema.int.test.ts` fails when they drift. `bigint` columns
read as numbers (throwing above `Number.MAX_SAFE_INTEGER`) and `date` columns as
`YYYY-MM-DD` strings. Write `jsonb` values with `jsonb(value)`.

## 10. Hosting and deploys

Each environment (`staging`, `prod`, and `personal`, the low-cost layout for one reseller in
their own account, priced in [costs.md](costs.md)) is its own AWS account, defined by the CDK
app in `infra/` and documented in [infra/README.md](../infra/README.md). In short:

- **One image, two services.** The root `Dockerfile` installs production dependencies and
  the sources; ECS runs `node apps/api/src/main.ts` or `node apps/worker/src/main.ts` from it,
  on Fargate in private subnets, with a read-only root file system. The API is behind an
  HTTPS load balancer at `api.<domain>` that health-checks `/health/live`. ECS replaces
  tasks that fail it, so it checks no dependency: a database failover must not restart every
  task. `/health/ready` (database reachable) is for deploy checks and operators. `personal`
  runs both containers in one task in public subnets (no NAT) behind an API Gateway HTTP API
  instead of the load balancer, and ECS runs the same `/health/live` check in the container.
  Personal can also run without a domain: the API then answers at the HTTP API's default
  `execute-api` URL, and no sale email is received until a domain is added.
- **Configuration.** Containers get exactly the environment in `infra/src/containers.ts`, and
  a test runs the API's and worker's config loaders on it. A task that adds a required config
  key adds it there (and, for a secret, to `APP_SECRETS` in `infra/src/config.ts`). The
  database password reaches the processes only as `PGPASSWORD` from the RDS secret.
- **Data.** RDS PostgreSQL 18 (Multi-AZ in prod; deletion protection in prod and personal), a
  private photo bucket whose `public/` prefix CloudFront serves by exact key (at its
  `*.cloudfront.net` domain), SES inbound mail for `in.<domain>` stored in a private bucket,
  and a KMS key for token envelope encryption.
- **Deploys** run only from the manual Deploy workflow, on `main`, inside the protected GitHub
  environment, with OIDC role assumption (no stored AWS keys). Images are tagged with the
  commit and immutable. The environment's protection rules and the CDK bootstrap's
  CloudFormation execution policy bound what a deploy can change (infra/README.md).
- **Migrations** run on every deploy as a one-off ECS task (`listora-<env>-migrate`, the
  worker's database access) after the image push and before the new services start; a
  failed migration stops the deploy. The previous release is still serving while they run,
  so every migration must be compatible with the code currently running: expand, then
  contract (add first and use in a later release; stop using first and drop in a later
  release).
- **Offline.** Synthesis never calls AWS: no `fromLookup`, zones resolve at deploy time, and
  `npm run infra:synth` (part of `npm run check`) runs `cdk synth` of every environment with
  credentials hidden.
  Template snapshots in `infra/src/__snapshots__/` make every infrastructure change a
  reviewable diff.

## 11. Testing and CI

- `npm run check` runs the format check, lint (ESLint and shellcheck), type check, the API
  contract check, the offline `cdk synth` of every environment, unit tests, and integration
  tests. It must pass before merge. When iOS code
  is touched, `make ios-lint` and `make ios-test` must pass too. `make ios-test` runs the
  package, unit, and UI tests on an existing iPhone 17 simulator and keeps DerivedData in
  `.build/ios`.
- Integration tests use a real Postgres: the local `listora_test` database from
  `scripts/dev-db.sh` (locally and in CI), or `TEST_DATABASE_URL` when set. They fail, and
  never skip, when the database is unreachable. Tests that need their own schema create a
  throwaway database with `createScratchDatabase` from `@listora/testing` and drop it after.
- Tests cover acceptance criteria **and failure paths**. Process-level tests start the real
  entry points with `node src/main.ts` (see `startNodeProcess` in `@listora/testing`).
- Every marketplace adapter passes the shared conformance suite against its fake, and its
  payloads, validation results, and assisted tasks are pinned by golden files (section 4).
  Sample listing content for tests in any workspace comes from `@listora/marketplaces/testing`.
- **API contract.** `packages/api-contract/openapi.yaml` is the only place an endpoint or
  payload shape is defined. The server imports its types from `@listora/api-contract` and
  the iOS app uses the generated `ListoraAPI` Swift package. `npm run contract:check` lints
  the spec, fails when the committed generated code is stale, and tests the Swift package.
  Its conventions (error model, idempotency keys, pagination, Money) are in
  [packages/api-contract/README.md](../packages/api-contract/README.md).
- CI runs the same fresh-clone path as local development; see the CI section of the
  [README](../README.md#ci). A Linux job builds the application image and smoke-tests it
  (`scripts/container-smoke.sh`). A macOS job runs `make ios-lint` and `make ios-test`, but
  only when a file the iOS build reads changed (macOS minutes cost 10 times Linux minutes);
  the Linux backend check runs on every pull request.

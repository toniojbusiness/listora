# Listora

Mobile-first reseller operating system: take photos once, create the item once, and manage it
everywhere (Depop, Poshmark, Mercari, eBay).

Read [docs/architecture.md](docs/architecture.md) before contributing. It covers the stack,
the conventions, and the product invariants, and links to each feature's own doc in
[docs/features/](docs/features/); [docs/README.md](docs/README.md) says where new docs go.
[docs/roadmap.md](docs/roadmap.md) is the phase overview.

## Prerequisites

- **Node 26** with npm 11 or newer (the version is pinned in `.nvmrc`, and installs fail on
  other majors). With nvm, run `nvm use`.
- **PostgreSQL 18 from Homebrew** (`postgresql@18`). `scripts/dev-db.sh` installs it if it is
  missing. On a machine without Homebrew, set `PG_BIN_DIR` to a PostgreSQL 18 `bin` directory.
- **shellcheck**, used by `npm run lint`. Install it with `brew install shellcheck`.
- **Swift 6 toolchain**, used by `npm run contract:check` to regenerate and test the Swift API
  client. It comes with Xcode on macOS (on Linux, install Swift 6 from swift.org).
- **Headless Chromium** for the browser runner and its tests: `scripts/dev-browser.sh`
  installs the build Playwright pins (about 200 MB) into `.local/playwright`.
- Docker is not needed.
- For the iOS app only: **Xcode 26.3 or 27.1** (CI uses 26.3; the app builds without warnings on
  both) with the iPhone 17 simulator, plus XcodeGen, SwiftLint, and SwiftFormat
  (`brew install xcodegen swiftlint swiftformat`). See
  [apps/ios/README.md](apps/ios/README.md). `make ios-test` also runs the backend (the setup
  below).

## Setup

```sh
npm ci                 # install the exact locked dependencies
scripts/dev-db.sh      # start this checkout's Postgres 18 cluster (.local/pg)
scripts/dev-browser.sh # install the browser runner's headless Chromium (.local/playwright)
npm run db:migrate     # apply the schema migrations to the dev database
npm run check          # format, lint, type check, unit + integration tests
```

`.env` is optional for local development because the defaults match `scripts/dev-db.sh`. To
run the API or the worker, or to change a port, copy `.env.example` to `.env` and edit it.
Every configuration key is documented there. Never commit `.env`. The worker processes
photos and runs item analyses for the API, so run `npm run dev:worker` next to
`npm run dev:api`; both use the same `STORAGE_LOCAL_DIR`. With `EBAY_ENV=fake` (the
`.env.example` setting) the worker lists on the fake eBay, so also start `npm run dev:fake-ebay`.
Depop runs assisted until Listora's Depop partner access is granted. To watch the worker run
Depop API operations locally (listings on a connection whose mode is `api`), set
`DEPOP_ENV=fake` and `DEPOP_USER_CONNECTION_ID` and start `npm run dev:fake-depop`.
To watch browser automation (decision D1,
[docs/features/automation.md](docs/features/automation.md)), set `FAKE_AUTOMATION_SITE_URL` and
start `npm run dev:fake-site`: Poshmark, Mercari, and Depop connections that hold a linked
session are then automated against that local site, and the worker starts the browser runner
as a child process whenever automated work waits. To watch the Poshmark adapter itself, also
set `FAKE_POSHMARK_URL` and start `npm run dev:fake-poshmark`
([docs/features/poshmark.md](docs/features/poshmark.md)).

### Signing in locally

With `AUTH_DRIVER=dev` (the `.env.example` setting), the API signs people in with a one-time
code that it prints to its log; [Signing in locally](docs/features/auth.md#signing-in-locally)
has the two requests. Staging and production use `AUTH_DRIVER=cognito`;
[docs/features/auth.md](docs/features/auth.md) covers both drivers, the user pool settings,
and in-app account deletion (`DELETE /v1/account`).

### Connecting eBay locally

Connecting an eBay account locally needs no eBay credential: the fake eBay stands in for
eBay's consent page and tokens. [Connecting locally](docs/features/ebay.md#connecting-locally)
has the steps.

## Commands

| Command                        | What it does                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run check`                | Format check, lint, type check, API contract check, infra synth, unit and integration tests                                                      |
| `npm run format`               | Rewrite files with Prettier                                                                                                                      |
| `npm run lint`                 | ESLint (type-aware, zero warnings) and shellcheck                                                                                                |
| `npm run typecheck`            | `tsc --build` over every workspace (type check only; no JS output)                                                                               |
| `npm run contract:generate`    | Bundle the API contract (`packages/api-contract/openapi.yaml` and the files it references) and regenerate the TypeScript types and Swift client  |
| `npm run contract:check`       | Lint the API spec, fail if the bundle or generated code is stale, and test the Swift client package                                              |
| `npm run infra:synth`          | `cdk synth` of the AWS stacks for every environment, offline with placeholder settings (see `infra/README.md`)                                   |
| `npm run test:unit`            | Unit tests (`*.test.ts`, no external services)                                                                                                   |
| `npm run test:integration`     | Integration tests (`*.int.test.ts`) against the local Postgres                                                                                   |
| `npm run dev:api`              | Run the API with reload on change (`http://127.0.0.1:3000/health/ready`)                                                                         |
| `npm run dev:worker`           | Run the worker with reload on change                                                                                                             |
| `npm run dev:fake-marketplace` | Run the fake marketplace at `FAKE_MARKETPLACE_URL`, for the worker in development                                                                |
| `npm run dev:fake-ebay`        | Run the fake eBay at `EBAY_FAKE_URL`, which the worker lists on and sellers connect with under `EBAY_ENV=fake`                                   |
| `npm run dev:fake-depop`       | Run the fake Depop at `DEPOP_FAKE_URL`, which api-connected Depop listings use with `DEPOP_ENV=fake`                                             |
| `npm run ebay:sandbox-token`   | Sign a sandbox test seller in on eBay and save their refresh token in `.env` (see [the sandbox check](docs/features/ebay.md#sandbox-check))      |
| `npm run ebay:sandbox-check`   | Run the eBay adapter end to end against eBay's sandbox; fails with what to set when keys are missing                                             |
| `npm run e2e:stack`            | Start the local end-to-end stack (API, worker, fakes, scratch database, signed-in user); `make ios-test` runs the iOS tests inside it            |
| `npm run dev:fake-site`        | Run the fake marketplace site at `FAKE_AUTOMATION_SITE_URL`, which browser automation drives in development                                      |
| `npm run dev:fake-poshmark`    | Run the fake Poshmark at `FAKE_POSHMARK_URL`, which the Poshmark automation adapter drives in development                                        |
| `npm run dev:runner`           | Run the browser runner by hand (the worker starts it on demand otherwise)                                                                        |
| `npm run db:migrate`           | Apply pending migrations and the job queue schema to `DATABASE_URL`; `-- status` lists them, `-- down <name>` reverts the latest one             |
| `npm run admin -- --help`      | Operator CLI: AI cost reports, the AI spend check, the AI kill switch and account blocks (with an audit trail)                                   |
| `npm run eval`                 | Score the tag parsers, AI tag reading, and the full item analysis on the synthetic corpus (fake AI); `-- --provider anthropic` uses the real API |
| `npm run corpus:render`        | Regenerate the synthetic tag corpus and its fake AI fixtures after changing the corpus generator                                                 |
| `scripts/dev-db.sh start`      | Initialize if needed and start the cluster; create the `listora` and `listora_test` databases (the default command)                              |
| `scripts/dev-db.sh stop`       | Stop the cluster                                                                                                                                 |
| `scripts/dev-db.sh reset`      | Delete all local data and start a fresh cluster                                                                                                  |
| `scripts/dev-db.sh status`     | Show whether the cluster is running and on which port                                                                                            |
| `scripts/dev-db.sh url test`   | Print a connection URL (`dev` or `test`)                                                                                                         |
| `scripts/dev-db.sh psql`       | Open psql on the dev database                                                                                                                    |
| `scripts/dev-browser.sh`       | Install the headless Chromium that the browser runner and its tests use, in `.local/playwright`                                                  |

The iOS app has its own `make` targets, run from the repository root. The full list is in
[apps/ios/README.md](apps/ios/README.md#commands).

| Command         | What it does                                                                          |
| --------------- | ------------------------------------------------------------------------------------- |
| `make ios-test` | Run every iOS test on the simulator, the backend UI tests against `npm run e2e:stack` |
| `make ios-lint` | SwiftLint (strict) and the SwiftFormat check                                          |
| `make ios-open` | Generate the Xcode project and open it in Xcode                                       |

The cluster listens only on `127.0.0.1`, on port `LISTORA_PG_PORT` (default 55432). Each
worktree has its own cluster. Give each worktree a different port in its `.env` if more than
one runs at the same time.

## Repository layout

```text
apps/api/               Fastify HTTP API (@listora/api)
apps/worker/            Background worker and the on-demand browser runner (@listora/worker)
apps/admin/             Operator CLI: AI cost reports, spend check, kill switch, blocks (@listora/admin)
apps/ios/               iPhone app: Swift 6 / SwiftUI, XcodeGen, local Swift packages
packages/ai/            AI provider layer: providers, price table, metering, budget guards, quota counter (@listora/ai)
packages/analysis/      Item analysis: prompt, output schema, provenance, marketplace copy, the job (@listora/analysis)
packages/batches/       Batch listing: batches, their items' state, the job that starts each item's analysis (@listora/batches)
packages/pricing/       Fee tables, cost floor, price tiers, research links, label guard (@listora/pricing)
packages/api-contract/  OpenAPI v1 contract + generated TS and Swift code (@listora/api-contract)
packages/db/            SQL migrations, migration runner, Kysely types (@listora/db)
packages/storage/       Object storage drivers: local disk (.local/storage) and S3 (@listora/storage)
packages/photos/        Image pipeline: derivatives, metadata stripping, hashes, processing job (@listora/photos)
packages/marketplaces/  Marketplace adapter framework, assisted adapters, the eBay and Depop adapters, eBay's connect client, the fake marketplace, fake eBay, and fake Depop (@listora/marketplaces)
packages/connections/   Marketplace connections: OAuth connect, token vault, browser session vault, credentials, health (@listora/connections)
packages/automation/    Browser automation: Playwright runner, safety rules, automation adapter base, the Poshmark adapter, sale checks, fake site, fake Poshmark (@listora/automation)
packages/operations/    Operation engine on Graphile Worker (@listora/operations)
packages/observability/ Trust metrics: catalog, CloudWatch EMF output, worker metrics job (@listora/observability)
packages/sales/         Sale intake, eBay notifications, the order poll, eBay account deletion (@listora/sales)
packages/shared/        Shared types and utilities (@listora/shared)
packages/testing/       Test-only helpers (@listora/testing)
packages/tag-parse/     Deterministic tag-text parsers (@listora/tag-parse)
packages/eval/          Synthetic tag corpus and eval harness CLI (@listora/eval)
packages/e2e/           Local end-to-end stack for the iOS UI tests: API and worker with fakes (@listora/e2e)
infra/                  AWS CDK stacks and deploy setup (@listora/infra; see infra/README.md)
scripts/                dev-db.sh (local PostgreSQL 18 cluster), dev-browser.sh (headless Chromium),
                        container-smoke.sh (image smoke test), ios-release.sh (iOS archive and
                        TestFlight upload)
Dockerfile              Images: `app` runs the API and the worker; `runner` adds headless Chromium
Makefile                iOS commands (make ios-*)
docs/                   Architecture overview, roadmap, one doc per feature (docs/features/)
```

## CI

`.github/workflows/ci.yml` runs on every pull request that is not a draft (marking a draft
ready for review starts it) and on every push to `main`. Branch pushes without a pull request
do not run CI, so one commit never runs twice. It has four jobs:

| Job                                              | Runner                   | When it does real work                                      |
| ------------------------------------------------ | ------------------------ | ----------------------------------------------------------- |
| `Detect changed areas`                           | Linux                    | Always; decides whether the iOS and image jobs build        |
| `Backend check (Linux)`                          | Linux                    | Always                                                      |
| `Application image build and smoke test (Linux)` | Linux                    | Only when an image input changed; otherwise a passing no-op |
| `iOS lint, build and test (macOS)`               | macOS, or Linux as no-op | Only when an iOS input changed                              |

The backend job installs PostgreSQL 18 from the PGDG apt repository (Swift comes with the
runner image), then runs `npm ci`, `scripts/dev-db.sh` (with
`PG_BIN_DIR=/usr/lib/postgresql/18/bin`), `scripts/dev-browser.sh --with-deps` (headless
Chromium and its system libraries), and `npm run check`. It caches npm downloads, the browser,
and the API contract's SwiftPM builds.

The image job runs `scripts/container-smoke.sh`: it builds the application and runner images,
checks that the runner image's browser starts, runs the schema migrations, and starts the
API, the worker, and the browser runner from them, configured as in AWS, against a
PostgreSQL container. It builds only when the change touches what decides whether the images
build and start: `Dockerfile`, `.dockerignore`, `.nvmrc`, `.npmrc`, `package.json`,
`package-lock.json`, any `apps/*/package.json` or `packages/*/package.json`, the entry points
`apps/api/src/main.ts`, `apps/worker/src/main.ts`, and `apps/worker/src/runner/main.ts`, the
files they read from the image at startup (the feature discovery indexes
`apps/api/src/features.ts` and `apps/worker/src/features.ts`, and the bundled contract
`packages/api-contract/bundled/**`), `infra/**`, `scripts/container-smoke.sh`, or
`.github/workflows/ci.yml` (the `image` filter in the `changes` job).

The iOS job, on a macOS runner with Xcode 26.3, installs XcodeGen, SwiftLint, SwiftFormat,
and PostgreSQL 18 from Homebrew and Node with `npm ci`, then runs `make ios-lint` and
`make ios-test`, whose UI tests that go through the backend run against the local stack
(`packages/e2e`). It caches the app's SwiftPM checkouts but not DerivedData, because a fresh
checkout resets the file timestamps Xcode's incremental build relies on. Before the tests it
shuts down every simulator and erases and boots the iPhone 17 one once, waiting until it has
finished booting. Every run, passed or failed, uploads the test results (`Test.xcresult`,
including the UI tests' screenshots), the failing-test summary, and the stack's API and worker
logs, and puts the summary in the job summary, so a failure names its test instead of a bare
`** TEST FAILED **`.

**Flaky test rule.** `make ios-test` retries a failing test up to twice
(`-retry-tests-on-failure -test-iterations 3`, locally and in CI). A test that fails every try
fails the run. A test that passes only on a retry does not block the merge, but it is still
flaky: the summary lists it under "Flaky", and it gets a follow-up fix (open a task for it in
the pull request description) rather than being left to retry forever. It builds only when the change touches a file the iOS build reads:
`apps/ios/**`, `packages/api-contract/**` (the OpenAPI spec and the generated `ListoraAPI`
Swift package), `packages/shared/fixtures/listing-urls.json` (the listing URL fixtures the iOS
parser is tested against), `packages/e2e/**` (the local stack), `Makefile`, or
`.github/workflows/ci.yml` (the `ios` filter). Other backend changes do not build it, though
the UI tests run the backend: the backend job covers them, and the contract keeps the API and
the app in step.

**Cost rule.** macOS runner minutes are the expensive ones, so the iOS and image jobs build
only when one of their inputs changed. Otherwise they succeed in seconds without building, so
they still report a result and can be required checks; they fail, rather than passing, when
change detection fails. When either build starts reading a new file, add it to its filter.

Which jobs do real work, by change:

| Change                           | Real work                      |
| -------------------------------- | ------------------------------ |
| iOS only (`apps/ios/**`)         | changes, backend, iOS          |
| Backend only (`apps/api/src/**`) | changes, backend               |
| Infra (`infra/**`, `Dockerfile`) | changes, backend, image        |
| Docs only                        | changes, backend               |
| Draft pull request               | nothing until ready for review |

A new push to a pull request cancels the run it supersedes. Runs on `main` are never
cancelled, so every merged commit gets a full result. Every job has a `timeout-minutes`
limit.

Deploys are separate: `.github/workflows/deploy.yml` runs only when started by hand for `staging`,
`prod`, or `personal` (one reseller's own low-cost setup, priced in
[docs/features/costs.md](docs/features/costs.md)), inside the protected GitHub environment of that
name, and reaches AWS through OIDC with no stored keys. Setup and the first deploy are described in
[infra/README.md](infra/README.md).

TestFlight uploads are separate too: `.github/workflows/testflight.yml` runs only when started
by hand on `main` for the `staging` or `prod` app, and uploads a signed iOS build from a macOS
runner. Setup and the release steps are in
[Releases in apps/ios/README.md](apps/ios/README.md#releases).

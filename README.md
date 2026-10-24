# Listora

Mobile-first reseller operating system: take photos once, create the item once, and manage it
everywhere (Depop, Poshmark, Mercari, eBay).

Read [docs/architecture.md](docs/architecture.md) before contributing. It covers the stack,
the conventions, and the product invariants. [docs/roadmap.md](docs/roadmap.md) lists the
tasks and how they depend on each other.

## Prerequisites

- **Node 26** with npm 11 or newer (the version is pinned in `.nvmrc`, and installs fail on
  other majors). With nvm, run `nvm use`.
- **PostgreSQL 18 from Homebrew** (`postgresql@18`). `scripts/dev-db.sh` installs it if it is
  missing. On a machine without Homebrew, set `PG_BIN_DIR` to a PostgreSQL 18 `bin` directory.
- **shellcheck**, used by `npm run lint`. Install it with `brew install shellcheck`.
- **Swift 6 toolchain**, used by `npm run contract:check` to regenerate and test the Swift API
  client. It comes with Xcode on macOS (on Linux, install Swift 6 from swift.org).
- Docker is not needed.
- For the iOS app only: **Xcode 26.3** with the iPhone 17 simulator, plus XcodeGen, SwiftLint,
  and SwiftFormat (`brew install xcodegen swiftlint swiftformat`). See
  [apps/ios/README.md](apps/ios/README.md).

## Setup

```sh
npm ci                 # install the exact locked dependencies
scripts/dev-db.sh      # start this checkout's Postgres 18 cluster (.local/pg)
npm run db:migrate     # apply the schema migrations to the dev database
npm run check          # format, lint, type check, unit + integration tests
```

`.env` is optional for local development because the defaults match `scripts/dev-db.sh`. To
run the API or the worker, or to change a port, copy `.env.example` to `.env` and edit it.
Every configuration key is documented there. Never commit `.env`. The worker processes
photos and runs item analyses for the API, so run `npm run dev:worker` next to
`npm run dev:api`; both use the same `STORAGE_LOCAL_DIR`. To watch the worker run marketplace
operations locally, also set `FAKE_MARKETPLACE_URL` and start `npm run dev:fake-marketplace`.

### Signing in locally

With `AUTH_DRIVER=dev` (the `.env.example` setting), the API signs people in with a one-time
code that it prints to its log instead of emailing it. The first sign-in of an email creates
its account.

```sh
curl -X POST localhost:3000/dev/auth/codes -H 'content-type: application/json' \
  -d '{"email": "you@example.com"}'
# The API log shows: dev sign-in code for you@example.com: 123456
curl -X POST localhost:3000/dev/auth/sessions -H 'content-type: application/json' \
  -d '{"email": "you@example.com", "code": "123456"}'
# → {"accessToken": "...", "tokenType": "Bearer", "expiresInSeconds": 86400}
```

Send the token as `Authorization: Bearer <accessToken>` on every `/v1` request, and an
`Idempotency-Key` header (a new UUID per action) on every POST.

Staging and production use `AUTH_DRIVER=cognito`, where the app signs in with the Cognito user
pool (Sign in with Apple or an emailed code). [docs/auth.md](docs/auth.md) covers both drivers,
the user pool settings, and in-app account deletion (`DELETE /v1/account`).

## Commands

| Command                        | What it does                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run check`                | Format check, lint, type check, API contract check, infra synth, unit and integration tests                                                      |
| `npm run format`               | Rewrite files with Prettier                                                                                                                      |
| `npm run lint`                 | ESLint (type-aware, zero warnings) and shellcheck                                                                                                |
| `npm run typecheck`            | `tsc --build` over every workspace (type check only; no JS output)                                                                               |
| `npm run contract:generate`    | Regenerate the TypeScript types and Swift client from `packages/api-contract/openapi.yaml`                                                       |
| `npm run contract:check`       | Lint the API spec, fail if generated code is stale, and test the Swift client package                                                            |
| `npm run infra:synth`          | `cdk synth` of the AWS stacks for every environment, offline with placeholder settings (see `infra/README.md`)                                   |
| `npm run test:unit`            | Unit tests (`*.test.ts`, no external services)                                                                                                   |
| `npm run test:integration`     | Integration tests (`*.int.test.ts`) against the local Postgres                                                                                   |
| `npm run dev:api`              | Run the API with reload on change (`http://127.0.0.1:3000/health/ready`)                                                                         |
| `npm run dev:worker`           | Run the worker with reload on change                                                                                                             |
| `npm run dev:fake-marketplace` | Run the fake marketplace at `FAKE_MARKETPLACE_URL`, for the worker in development                                                                |
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

The iOS app has its own `make` targets, run from the repository root. The full list is in
[apps/ios/README.md](apps/ios/README.md#commands).

| Command         | What it does                                                         |
| --------------- | -------------------------------------------------------------------- |
| `make ios-test` | Generate the Xcode project, then run every iOS test on the simulator |
| `make ios-lint` | SwiftLint (strict) and the SwiftFormat check                         |
| `make ios-open` | Generate the Xcode project and open it in Xcode                      |

The cluster listens only on `127.0.0.1`, on port `LISTORA_PG_PORT` (default 55432). Each
worktree has its own cluster. Give each worktree a different port in its `.env` if more than
one runs at the same time.

## Repository layout

```text
apps/api/               Fastify HTTP API (@listora/api)
apps/worker/            Background worker (@listora/worker)
apps/admin/             Operator CLI: AI cost reports, spend check, AI kill switch (@listora/admin)
apps/ios/               iPhone app: Swift 6 / SwiftUI, XcodeGen, local Swift packages
packages/ai/            AI provider layer: providers, price table, metering, budget guards, quota counter (@listora/ai)
packages/analysis/      Item analysis: prompt, output schema, provenance, marketplace copy, the job (@listora/analysis)
packages/pricing/       Fee tables, cost floor, price tiers, research links, label guard (@listora/pricing)
packages/api-contract/  OpenAPI v1 contract + generated TS and Swift code (@listora/api-contract)
packages/db/            SQL migrations, migration runner, Kysely types (@listora/db)
packages/storage/       Object storage drivers: local disk (.local/storage) and S3 (@listora/storage)
packages/photos/        Image pipeline: derivatives, metadata stripping, hashes, processing job (@listora/photos)
packages/marketplaces/  Marketplace adapter framework, assisted adapters, and the fake marketplace (@listora/marketplaces)
packages/operations/    Operation engine on Graphile Worker (@listora/operations)
packages/shared/        Shared types and utilities (@listora/shared)
packages/testing/       Test-only helpers (@listora/testing)
packages/tag-parse/     Deterministic tag-text parsers (@listora/tag-parse)
packages/eval/          Synthetic tag corpus and eval harness CLI (@listora/eval)
infra/                  AWS CDK stacks and deploy setup (@listora/infra; see infra/README.md)
scripts/                dev-db.sh (local PostgreSQL 18 cluster), container-smoke.sh (image smoke test),
                        ios-release.sh (iOS archive and TestFlight upload)
Dockerfile              Application image: one image runs the API and the worker
Makefile                iOS commands (make ios-*)
docs/                   Architecture overview, roadmap, personal environment cost estimate
```

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs the same fresh-clone path as local
development on every pull request and on every push to `main`. Branch pushes without a pull
request do not run CI, so one change never runs twice. It has four jobs:

| Job                                              | Runner                   | When it does real work                  |
| ------------------------------------------------ | ------------------------ | --------------------------------------- |
| `Detect changed areas`                           | Linux                    | Always; decides whether iOS is affected |
| `Backend check (Linux)`                          | Linux                    | Always                                  |
| `Application image build and smoke test (Linux)` | Linux                    | Always                                  |
| `iOS lint, build and test (macOS)`               | macOS, or Linux as no-op | Only when an iOS input changed          |

The backend job installs PostgreSQL 18 from the PGDG apt repository (Swift comes with the
runner image), then runs `npm ci`, `scripts/dev-db.sh` (with
`PG_BIN_DIR=/usr/lib/postgresql/18/bin`), and `npm run check`. It caches npm downloads and
the API contract's SwiftPM builds.

The image job runs `scripts/container-smoke.sh`: it builds the application image, runs the
schema migrations, and starts the API and the worker from it, configured as in AWS, against
a PostgreSQL container.

The iOS job, on a macOS runner with Xcode 26.3, installs XcodeGen, SwiftLint, and SwiftFormat
from Homebrew, then runs `make ios-lint` and `make ios-test`. It caches the app's SwiftPM
checkouts but not DerivedData, because a fresh checkout resets the file timestamps Xcode's
incremental build relies on.

**Cost rule.** macOS runner minutes bill at 10 times Linux minutes, so the iOS job builds
only when the pull request (or the pushed `main` commit) changes a file the iOS build reads:
`apps/ios/**`, `packages/api-contract/**` (the OpenAPI spec and the generated `ListoraAPI`
Swift package), `Makefile`, or `.github/workflows/ci.yml`. Otherwise it runs on Linux and
succeeds in seconds without building, so it still reports a result and can be a required
check. It fails, rather than passing, when change detection fails. When the iOS build starts
reading a new file outside these paths, add it to the `ios` filter in the `changes` job.

A new push to a pull request cancels the run it supersedes. Runs on `main` are never
cancelled, so every merged commit gets a full result. Every job has a `timeout-minutes`
limit.

Deploys are separate: `.github/workflows/deploy.yml` runs only when started by hand for
`staging`, `prod`, or `personal` (one reseller's own low-cost setup, priced in
[docs/costs.md](docs/costs.md)), inside the protected GitHub environment of that name, and reaches AWS
through OIDC with no stored keys. Setup and the first deploy are described in
[infra/README.md](infra/README.md).

TestFlight uploads are separate too: `.github/workflows/testflight.yml` runs only when started
by hand on `main` for the `staging` or `prod` app, and uploads a signed iOS build from a macOS
runner. Setup and the release steps are in
[Releases in apps/ios/README.md](apps/ios/README.md#releases).

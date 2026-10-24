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
run the API, or to change a port, copy `.env.example` to `.env` and edit it. Every
configuration key is documented there. Never commit `.env`.

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

## Commands

| Command                      | What it does                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `npm run check`              | Everything CI runs: format check, lint, type check, API contract check, unit and integration tests                  |
| `npm run format`             | Rewrite files with Prettier                                                                                         |
| `npm run lint`               | ESLint (type-aware, zero warnings) and shellcheck                                                                   |
| `npm run typecheck`          | `tsc --build` over every workspace (type check only; no JS output)                                                  |
| `npm run contract:generate`  | Regenerate the TypeScript types and Swift client from `packages/api-contract/openapi.yaml`                          |
| `npm run contract:check`     | Lint the API spec, fail if generated code is stale, and test the Swift client package                               |
| `npm run test:unit`          | Unit tests (`*.test.ts`, no external services)                                                                      |
| `npm run test:integration`   | Integration tests (`*.int.test.ts`) against the local Postgres                                                      |
| `npm run dev:api`            | Run the API with reload on change (`http://127.0.0.1:3000/health/ready`)                                            |
| `npm run dev:worker`         | Run the worker with reload on change                                                                                |
| `npm run db:migrate`         | Apply pending migrations to `DATABASE_URL`; `-- status` lists them, `-- down <name>` reverts the latest one         |
| `npm run eval`               | Score the tag parsers and a provider on the synthetic corpus; the stub stands until T-08 adds the fake provider     |
| `npm run corpus:render`      | Regenerate the synthetic tag corpus in `packages/eval/corpus` after changing its generator                          |
| `scripts/dev-db.sh start`    | Initialize if needed and start the cluster; create the `listora` and `listora_test` databases (the default command) |
| `scripts/dev-db.sh stop`     | Stop the cluster                                                                                                    |
| `scripts/dev-db.sh reset`    | Delete all local data and start a fresh cluster                                                                     |
| `scripts/dev-db.sh status`   | Show whether the cluster is running and on which port                                                               |
| `scripts/dev-db.sh url test` | Print a connection URL (`dev` or `test`)                                                                            |
| `scripts/dev-db.sh psql`     | Open psql on the dev database                                                                                       |

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
apps/api/              Fastify HTTP API (@listora/api)
apps/worker/           Background worker (@listora/worker)
apps/ios/              iPhone app: Swift 6 / SwiftUI, XcodeGen, local Swift packages
packages/api-contract/ OpenAPI v1 contract + generated TS and Swift code (@listora/api-contract)
packages/db/           SQL migrations, migration runner, Kysely types (@listora/db)
packages/shared/       Shared types and utilities (@listora/shared)
packages/testing/      Test-only helpers (@listora/testing)
packages/tag-parse/    Deterministic tag-text parsers (@listora/tag-parse)
packages/eval/         Synthetic tag corpus and eval harness CLI (@listora/eval)
infra/                 AWS CDK (placeholder until T-30)
scripts/dev-db.sh      Local PostgreSQL 18 cluster
Makefile               iOS commands (make ios-*)
docs/                  Architecture overview and roadmap
```

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs the same fresh-clone path as local
development on every pull request and on every push to `main`: on Linux it installs
PostgreSQL 18 from the PGDG apt repository (Swift comes with the runner image), then runs
`npm ci`, `scripts/dev-db.sh` (with `PG_BIN_DIR=/usr/lib/postgresql/18/bin`), and
`npm run check`. A second job on a macOS runner, with Xcode 26.3, installs XcodeGen,
SwiftLint, and SwiftFormat from Homebrew, then runs `make ios-lint` and `make ios-test`.

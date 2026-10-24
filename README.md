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
- Docker is not needed.
- Xcode 26 with the iPhone 17 simulator is needed for the iOS app once T-02 lands.

## Setup

```sh
npm ci                 # install the exact locked dependencies
scripts/dev-db.sh      # start this checkout's Postgres 18 cluster (.local/pg)
npm run check          # format, lint, type check, unit + integration tests
```

`.env` is optional for local development because the defaults match `scripts/dev-db.sh`. To
run the API, or to change a port, copy `.env.example` to `.env` and edit it. Every
configuration key is documented there. Never commit `.env`.

## Commands

| Command                      | What it does                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `npm run check`              | Everything CI runs: format check, lint, type check, unit and integration tests                                      |
| `npm run format`             | Rewrite files with Prettier                                                                                         |
| `npm run lint`               | ESLint (type-aware, zero warnings) and shellcheck                                                                   |
| `npm run typecheck`          | `tsc --build` over every workspace (type check only; no JS output)                                                  |
| `npm run test:unit`          | Unit tests (`*.test.ts`, no external services)                                                                      |
| `npm run test:integration`   | Integration tests (`*.int.test.ts`) against the local Postgres                                                      |
| `npm run dev:api`            | Run the API with reload on change (`http://127.0.0.1:3000/health/ready`)                                            |
| `npm run dev:worker`         | Run the worker with reload on change                                                                                |
| `scripts/dev-db.sh start`    | Initialize if needed and start the cluster; create the `listora` and `listora_test` databases (the default command) |
| `scripts/dev-db.sh stop`     | Stop the cluster                                                                                                    |
| `scripts/dev-db.sh reset`    | Delete all local data and start a fresh cluster                                                                     |
| `scripts/dev-db.sh status`   | Show whether the cluster is running and on which port                                                               |
| `scripts/dev-db.sh url test` | Print a connection URL (`dev` or `test`)                                                                            |
| `scripts/dev-db.sh psql`     | Open psql on the dev database                                                                                       |

The cluster listens only on `127.0.0.1`, on port `LISTORA_PG_PORT` (default 55432). Each
worktree has its own cluster. Give each worktree a different port in its `.env` if more than
one runs at the same time.

## Repository layout

```text
apps/api/          Fastify HTTP API (@listora/api)
apps/worker/       Background worker (@listora/worker)
apps/ios/          iPhone app (placeholder until T-02)
packages/shared/   Shared types and utilities (@listora/shared)
packages/testing/  Test-only helpers (@listora/testing)
infra/             AWS CDK (placeholder until T-30)
scripts/dev-db.sh  Local PostgreSQL 18 cluster
docs/              Architecture overview and roadmap
```

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs `npm ci` and `npm run check` on Linux
against a `postgres:18` service container on every pull request and on every push to `main`.
T-02 adds the macOS iOS job.

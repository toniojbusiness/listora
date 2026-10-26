# Hosting and deploys

Each environment (`staging`, `prod`, and `personal`, the low-cost layout for one reseller in
their own account, priced in [costs.md](costs.md)) is its own AWS account, defined by the CDK
app in `infra/` and documented in [infra/README.md](../../infra/README.md). In short:

- **One image, two services, and the runner.** The root `Dockerfile` installs production
  dependencies and the sources; ECS runs `node apps/api/src/main.ts` or
  `node apps/worker/src/main.ts` from it,
  on Fargate in private subnets, with a read-only root file system. The API is behind an
  HTTPS load balancer at `api.<domain>` that health-checks `/health/live`. ECS replaces
  tasks that fail it, so it checks no dependency: a database failover must not restart every
  task. `/health/ready` (database reachable) is for deploy checks and operators. `personal`
  runs both containers in one task in public subnets (no NAT) behind an API Gateway HTTP API
  instead of the load balancer, and ECS runs the same `/health/live` check in the container.
  Personal can also run without a domain: the API then answers at the HTTP API's default
  `execute-api` URL, and no sale email is received until a domain is added. The browser runner
  ([automation.md](automation.md)) is a third service (`runner`, sized by `browserRunner`) from
  the Dockerfile's `runner` stage (the same sources with headless Chromium, its own
  repository), with no task while idle: the worker sets its desired count to 1 and the runner
  sets it back to 0. Its writable `/tmp` is a volume the image declares and owns, because
  Fargate otherwise creates it root-owned and the unprivileged runner's Chromium cannot start. It never runs two tasks at once, and its role alone may decrypt sellers'
  browser sessions.
- **Configuration.** Containers get exactly the environment in `infra/src/containers.ts`, and
  a test runs the API's, the worker's, and the runner's config loaders on it. A task that adds a required config
  key adds it there (and, for a secret, to `APP_SECRETS` in `infra/src/config.ts`). The
  database password reaches the processes only as `PGPASSWORD` from the RDS secret.
- **Data.** RDS PostgreSQL 18 (Multi-AZ in prod; deletion protection in prod and personal), a
  private photo bucket whose `public/` prefix CloudFront serves by exact key (at its
  `*.cloudfront.net` domain; the bucket policy lets CloudFront read only `public/`), SES inbound mail for `in.<domain>` stored in a private bucket and announced to the worker's
  queue ([email-sales.md](email-sales.md)),
  and a KMS key for the envelope encryption of marketplace credentials (`TOKEN_KMS_KEY_ID`:
  every task may `GenerateDataKey`; the worker may also `Decrypt` OAuth tokens, and the runner
  browser sessions, each only its own purpose).
- **Deploys** run only from the manual Deploy workflow, on `main`, inside the protected GitHub
  environment, with OIDC role assumption (no stored AWS keys). Images are tagged with the
  commit and immutable. The environment's protection rules and the CDK bootstrap's
  CloudFormation execution policy bound what a deploy can change (infra/README.md). Every
  bootstrap uses the restricted execution policy in `infra/src/deploy/execution-policy.ts`,
  never `AdministratorAccess`.
- **Personal deploys** are one command from a Mac, `scripts/deploy-personal.sh --profile
<profile>` (`--dry-run` checks everything offline and prints each step). It refuses any
  account but the captain's, bootstraps with the restricted policy, runs the workflow's steps
  in the same order, stores the Anthropic key from `~/.config/listora/anthropic.env`, and ends
  with a smoke test (`infra/src/deploy/smoke.ts`: health, that the API refuses requests
  without a token and has no dev sign-in, and with `LISTORA_SMOKE_ID_TOKEN` creating and
  deleting an item; no AI usage). Personal signs in only with its owner pool, the auth stack
  (a Cognito user pool whose one user is `LISTORA_OWNER_EMAIL`; [auth.md](auth.md)): the
  script refuses the dev driver, and on the first deploy waits for the owner to click SES's
  verification link before it deploys the pool. The steps, rollback, teardown (the database's deletion protection), and how to
  point the iPhone app at the printed URL are in infra/README.md, Deploying the personal
  environment.
- **Migrations** run on every deploy as a one-off ECS task (`listora-<env>-migrate`, the
  worker's database access) after the image push and before the new services start; a
  failed migration stops the deploy. The previous release is still serving while they run,
  so every migration must be compatible with the code currently running: expand, then
  contract (add first and use in a later release; stop using first and drop in a later
  release).
- **Alarms.** The observability stack alarms on the worker's trust metrics
  ([observability.md](observability.md#trust-metrics-and-alarms)).
- **Offline.** Synthesis never calls AWS: no `fromLookup`, zones resolve at deploy time, and
  `npm run infra:synth` (part of `npm run check`) runs `cdk synth` of every environment with
  credentials hidden.
  Template snapshots in `infra/src/__snapshots__/` make every infrastructure change a
  reviewable diff.
- **Code-only deploys.** `scripts/deploy-personal.sh --code-only` is the fast path for a
  commit that changes no infrastructure. It compares every synthesized template (all but the
  image tag), the bootstrap's execution policy, and the Anthropic key with what is deployed
  and refuses, changing nothing, when anything differs, naming the full deploy to run instead.
  Otherwise it builds and pushes the images with layer caching (the deployed images' layers
  and the builder's cache), runs the migrations only when `packages/db/migrations` changed
  since the commit the services run, registers task definition revisions that differ from the
  compute stack's only in the image tags, and moves the services to them through ECS, waiting
  until each rollout completes (a circuit-breaker rollback fails the deploy); then the same
  health wait and smoke test. Personal's app service replaces its one task in place
  (`deployments: 'replace'`, minimum healthy 0%), so the API is down for about a minute during
  any deploy; staging and prod keep rolling deploys. The next full deploy puts the services
  back on the stacks' own task definitions. Details: infra/README.md, Code-only deploys.

### Deploy times

Measured on the real personal environment (us-east-1, from an M1 Mac building `linux/amd64`
images with a warm builder cache), for a commit that changes no image input (docs only):

| Deploy                                                        | Time  | Of which                                                     |
| ------------------------------------------------------------- | ----- | ------------------------------------------------------------ |
| Full, before (`deploy-personal.sh`, rolling task replacement) | 7m52s | compute stack update 4m43s, migrations 53s, other stacks 47s |
| Full, after (task replaced in place)                          | 7m04s | compute stack update 3m45s, migrations 67s, other stacks 51s |
| `--code-only`, rolling task replacement                       | 4m27s | ECS rollout 3m24s, images 28s, checks 32s                    |
| `--code-only`, task replaced in place                         | TBD   | TBD                                                          |

Most of what remains is ECS: starting a Fargate task (about a minute), then up to two more
minutes before ECS reports the rollout complete, which the deploy waits for.

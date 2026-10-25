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
  sets it back to 0. It never runs two tasks at once, and its role alone may decrypt sellers'
  browser sessions.
- **Configuration.** Containers get exactly the environment in `infra/src/containers.ts`, and
  a test runs the API's, the worker's, and the runner's config loaders on it. A task that adds a required config
  key adds it there (and, for a secret, to `APP_SECRETS` in `infra/src/config.ts`). The
  database password reaches the processes only as `PGPASSWORD` from the RDS secret.
- **Data.** RDS PostgreSQL 18 (Multi-AZ in prod; deletion protection in prod and personal), a
  private photo bucket whose `public/` prefix CloudFront serves by exact key (at its
  `*.cloudfront.net` domain), SES inbound mail for `in.<domain>` stored in a private bucket,
  and a KMS key for the envelope encryption of marketplace credentials (`TOKEN_KMS_KEY_ID`:
  every task may `GenerateDataKey`; the worker may also `Decrypt` OAuth tokens, and the runner
  browser sessions, each only its own purpose).
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
- **Alarms.** The observability stack alarms on the worker's trust metrics
  ([observability.md](observability.md#trust-metrics-and-alarms)).
- **Offline.** Synthesis never calls AWS: no `fromLookup`, zones resolve at deploy time, and
  `npm run infra:synth` (part of `npm run check`) runs `cdk synth` of every environment with
  credentials hidden.
  Template snapshots in `infra/src/__snapshots__/` make every infrastructure change a
  reviewable diff.

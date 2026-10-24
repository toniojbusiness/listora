# Listora infrastructure

AWS infrastructure as code for the staging and prod environments, written with AWS CDK v2 in
TypeScript (`@listora/infra`). Each environment is a separate AWS account. Synthesis and all
tests run offline: `npm run check` needs no AWS account and no credentials.

## Stacks

One CDK app defines one environment at a time (`-c env=staging|prod`). Every stack is named
`listora-<env>-<name>`, tagged `project=listora` and `environment=<env>`, and in prod has
CloudFormation termination protection.

| Stack           | What it holds                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy-access` | GitHub OIDC provider and the `listora-<env>-github-deploy` role. Deployed once by an administrator; the workflow does not deploy it (a convention, not an enforced limit: see [Trust boundary](#trust-boundary)).                                                                                                                                     |
| `registry`      | ECR repository `listora/app`: immutable tags (one per commit), scan on push, the newest 50 images kept.                                                                                                                                                                                                                                               |
| `network`       | VPC across two zones: `public` (ALB, NAT), `app` (Fargate tasks), `data` (RDS, no route out). One NAT gateway in staging, one per zone in prod; an S3 gateway endpoint keeps photo and image traffic off NAT. Rejected-traffic flow logs. Every security group.                                                                                       |
| `secrets`       | KMS key `alias/listora-<env>-tokens` (yearly rotation, never deleted) for marketplace token envelope encryption, and the app secrets in `APP_SECRETS` (`listora/<env>/<name>`).                                                                                                                                                                       |
| `data`          | RDS PostgreSQL 18: encrypted, private, TLS required, daily backups (7 days staging, 30 prod), storage autoscaling, Multi-AZ and deletion protection in prod, a final snapshot on removal. The password is generated into `listora/<env>/database`.                                                                                                    |
| `migrate`       | The schema migration task `listora-<env>-migrate` (its own cluster, log group `/listora/<env>/migrate`, and roles): the worker's database access running `node packages/db/src/cli.ts latest` from the deployed image. Outputs the app subnets and worker security group for `ecs run-task`.                                                          |
| `storage`       | Private photo bucket (versioned, TLS only, old versions expire after 30 days) and a CloudFront distribution that serves only `public/` objects by exact key, for marketplace image fetch.                                                                                                                                                             |
| `email`         | SES domain identity (Easy DKIM), MX for `in.<domain>`, and a receipt rule that scans each message and stores it under `inbound/` in a private bucket (kept 90 days).                                                                                                                                                                                  |
| `compute`       | ECS cluster with Fargate services `api` and `worker` (one image, private subnets, CPU autoscaling, rollback on a failed deploy), an HTTPS ALB at `api.<domain>` health-checked on `/health/live`, service log groups, and a task role per service.                                                                                                    |
| `observability` | Alarm topic (optional email subscription) and baseline alarms: API 5xx, ALB 5xx, unhealthy tasks, p95 latency, service CPU and memory, database CPU, storage, and memory, plus RDS low-storage events (including storage autoscaling at its ceiling). Log groups sit with the stacks that write them; retention is 30 days in staging and 90 in prod. |

Sizes, redundancy, and retention per environment are in `ENVIRONMENT_SETTINGS`
(`src/config.ts`), so a change shows up in review as a code and snapshot diff.

### How the pieces connect

- **Database credentials.** `DATABASE_URL` names the host, port, database, and user but no
  password. ECS injects `PGPASSWORD` from the RDS secret, and node-postgres uses it for a URL
  without a password. TLS is verified (`sslmode=verify-full`) against the RDS certificate
  bundle that the image installs.
- **Container configuration.** `src/containers.ts` is the only place the container
  environment is defined. `containers.test.ts` runs the API's and worker's real config loaders
  on it, so a task that adds a required config key fails the tests until it adds the key there.
- **Task roles (least privilege).** Both services: read and write the photo bucket, and
  `kms:GenerateDataKey` / `kms:Decrypt` on the token key. Worker only: read raw sale email
  under `inbound/`. Each service can read only its own secrets. These grants are the designed
  access for T-07 (storage), T-16 (token vault), and T-23 (email ingest), which add their
  config keys to `src/containers.ts`.
- **Schema migrations.** Every deploy runs the migration task after the image push and
  before the compute stack, waits for it to stop, and stops unless it exits 0. The previous
  release keeps serving while migrations apply, so **every migration must be compatible with
  the code currently running**: expand, then contract. Add a column or table in one release
  and start using it in the next; stop using a column in one release and drop it in a later
  one. A migration that renames, drops, or tightens something the running code uses breaks
  production until the new tasks are up.
- **Photo URLs.** CloudFront's origin path is `/public`, so `https://<cdn>/<key>` serves
  `public/<key>` and nothing else. It has no list permission, so a missing key looks the same
  as a forbidden one. Keys must be unguessable (random, at least 128 bits).
- **Cross-stack references** are weak (`Fn::GetStackOutput`, the CDK default for new
  projects), so a producing stack can change without being blocked by exports. App secrets and
  the image repository in the deploy role's policy are referenced by name.

## Commands

Run from the repository root.

| Command                                  | What it does                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `npm run infra:synth`                    | `cdk synth` for both environments with placeholder settings, with AWS credentials hidden (offline) |
| `npx vitest run --project unit infra`    | Infra tests: config, assertions per stack and environment, template snapshots, deploy workflow     |
| `npx vitest run --project unit infra -u` | Refresh the template snapshots in `src/__snapshots__/` after an intended change; review the diff   |

Commands that talk to AWS (`cdk diff`, `cdk deploy`) run from `infra/` with that account's
credentials and the settings below, for example `npx cdk diff -c env=staging`.

## Settings

Account ids and domains are never committed. `loadDeployTarget` reads each setting from CDK
context (`-c key=value`) or else an environment variable (all documented in `.env.example`),
and fails fast, naming the missing or invalid key without printing its value.

| Context key        | Environment variable        | Required | Meaning                                                        |
| ------------------ | --------------------------- | -------- | -------------------------------------------------------------- |
| `env`              | `LISTORA_ENV`               | yes      | `staging` or `prod`                                            |
| `account`          | `LISTORA_AWS_ACCOUNT_ID`    | yes      | The environment's 12-digit AWS account id                      |
| `region`           | `LISTORA_AWS_REGION`        | no       | Default `us-east-1`; SES must receive email there              |
| `domain`           | `LISTORA_DOMAIN`            | yes      | For example `staging.listora.app`                              |
| `hostedZoneId`     | `LISTORA_HOSTED_ZONE_ID`    | yes      | Route 53 public hosted zone for `domain`                       |
| `imageTag`         | `LISTORA_IMAGE_TAG`         | yes      | Image tag to run (the commit SHA); `latest` is refused         |
| `alarmEmail`       | `LISTORA_ALARM_EMAIL`       | no       | Subscribed to the alarm topic                                  |
| `githubRepository` | `LISTORA_GITHUB_REPOSITORY` | no       | Repository allowed to deploy; default `toniojbusiness/listora` |

## First deploy of an environment

Do this once per environment (staging first), with administrator credentials for that
account. The examples use staging.

1. **Accounts and DNS.** Create the account (AWS Organizations) and a Route 53 public hosted
   zone for the environment's domain (for example `staging.listora.app`, delegated from the
   parent zone). Note the account id and hosted zone id.
2. **Bootstrap CDK** in the account and region:
   `npx cdk bootstrap aws://<account>/us-east-1` (from `infra/`). The bootstrap's
   CloudFormation execution policy (`AdministratorAccess` by default) is the ceiling on what
   any deploy can change; see [Trust boundary](#trust-boundary).
3. **Deploy access.** From `infra/`, with the settings exported (or as `-c` flags):
   `npx cdk deploy listora-staging-deploy-access`. If the account already has the GitHub OIDC
   provider, remove it first or import it; an account can have only one per URL.
4. **GitHub environment.** In the repository settings create the environment `staging` (and
   later `prod`) with protection rules: required reviewers, and deployment branches limited to
   `main`. Add the environment variables `AWS_ACCOUNT_ID`, `AWS_REGION`, `DOMAIN`,
   `HOSTED_ZONE_ID`, and optionally `ALARM_EMAIL`. No secrets are needed.
5. **Deploy.** Run the **Deploy** workflow (Actions tab) on `main` with `staging`. It tests
   and synthesizes offline, assumes the deploy role through OIDC, deploys the registry, builds
   and pushes the image tagged with the commit, deploys the state stacks and the migrate
   stack, runs the schema migrations (on a first deploy, every migration from an empty
   database), and only then deploys compute and observability. ACM and SES validate through
   the hosted zone, so the first run waits for DNS. If the migrations fail, the workflow stops
   before any new task starts; the task's logs are in `/listora/<env>/migrate`.
6. **Activate the SES receipt rule set** (one per account and region can be active, and
   CloudFormation cannot activate it):
   `aws ses set-active-receipt-rule-set --rule-set-name listora-staging`. Request SES
   production access if the account will send email.
7. **Set the app secrets.** Each secret in `APP_SECRETS` starts with a random placeholder.
   Set real values with `aws secretsmanager put-secret-value --secret-id
listora/staging/<name> --secret-string ...`, then redeploy or force a new ECS deployment so
   tasks read them.

Later deploys are step 5 only.

## Trust boundary

The deploy role can assume the CDK bootstrap roles, and the bootstrap's CloudFormation
execution role has `AdministratorAccess` unless the bootstrap restricted it. So a job holding
the deploy role can change anything in the account, including the `deploy-access` stack and
the role's own trust policy. The workflow leaving `deploy-access` to an administrator is a
convention, not an enforced limit. What actually bounds a deploy:

- the GitHub environment's protection rules (required reviewers, `main` only), which decide
  who can run a job that assumes the role, and
- the bootstrap's CloudFormation execution policy, which decides what that job can change.

**Follow-up (T-33, security hardening):** bootstrap with a restricted
`--cloudformation-execution-policies` and a permissions boundary on the roles it creates, so
a deploy can change only Listora's own resources and never the deploy role itself.

## Conventions

- Stacks extend `ListoraStack` (`src/stacks/common.ts`), which resolves availability zones at
  deploy time instead of looking them up, so synthesis never calls AWS. Never use `fromLookup`
  methods; pass ids through settings instead. `npm run infra:synth` hides AWS credentials, so
  a lookup fails there.
- `cdk.json` holds the app command and the CDK feature flags recommended for new projects;
  the tests load the same flags.
- The TypeScript settings are the repository's, except `exactOptionalPropertyTypes`, which
  aws-cdk-lib's own types do not support.

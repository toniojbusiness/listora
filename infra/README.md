# Listora infrastructure

AWS infrastructure as code for the staging, prod, and personal environments, written with AWS
CDK v2 in TypeScript (`@listora/infra`). Each environment is a separate AWS account. Synthesis
and all tests run offline: `npm run check` needs no AWS account and no credentials.

`staging` and `prod` are the product's environments. `personal` is the low-cost layout for one
reseller running Listora in their own AWS account; see
[The personal environment](#the-personal-environment) and [docs/features/costs.md](../docs/features/costs.md).

## Stacks

One CDK app defines one environment at a time (`-c env=staging|prod|personal`). Every stack is
named `listora-<env>-<name>`, tagged `project=listora` and `environment=<env>`, and in prod and
personal (`protectData`) has CloudFormation termination protection. The table describes
staging and prod; personal swaps a few pieces for cheaper ones (below).

| Stack           | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy-access` | GitHub OIDC provider and the `listora-<env>-github-deploy` role. Deployed once by an administrator; the workflow does not deploy it (a convention, not an enforced limit: see [Trust boundary](#trust-boundary)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `registry`      | ECR repositories `listora/app` and `listora/runner` (the browser runner's image): immutable tags (one per commit), scan on push, the newest 50 images kept.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `network`       | VPC across two zones: `public` (ALB, NAT), `app` (Fargate tasks), `data` (RDS, no route out). One NAT gateway in staging, one per zone in prod; an S3 gateway endpoint keeps photo and image traffic off NAT. Rejected-traffic flow logs. Every security group.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `secrets`       | KMS key `alias/listora-<env>-tokens` (yearly rotation, never deleted) for marketplace token envelope encryption, and the app secrets in `APP_SECRETS` (`listora/<env>/<name>`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `data`          | RDS PostgreSQL 18: encrypted, private, TLS required, daily backups (7 days staging, 30 prod), storage autoscaling, Multi-AZ and deletion protection in prod, a final snapshot on removal. The password is generated into `listora/<env>/database`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `migrate`       | The schema migration task `listora-<env>-migrate` (its own cluster, log group `/listora/<env>/migrate`, and roles): the worker's database access running `node packages/db/src/cli.ts latest` from the deployed image. Outputs the task subnets, worker security group, and public IP setting for `ecs run-task`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `storage`       | Private photo bucket (versioned, TLS only, old versions expire after 30 days, the browser runner's `automation/` screenshots after 30 days at most) and a CloudFront distribution that serves only `public/` objects by exact key, for marketplace image fetch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `email`         | SES domain identity (Easy DKIM), MX for `in.<domain>`, a receipt rule that scans each message, stores it under `inbound/` in a private bucket, and notifies an SNS topic that feeds the worker's encrypted SQS queue (with a dead-letter queue); the worker deletes each message once processed, and a lifecycle rule removes any left after 14 days. Without a domain, only the empty bucket. See docs/features/email-sales.md.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `compute`       | ECS cluster with Fargate services `api` and `worker` (one image, private subnets, CPU autoscaling, rollback on a failed deploy), an HTTPS ALB at `api.<domain>` health-checked on `/health/live`, service log groups, and a task role per service; and the browser runner's `runner` service (its own image, 0 tasks while idle, at most 1, `/listora/<env>/runner` logs).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `observability` | Alarm topic (optional email subscription) and baseline alarms: API 5xx, ALB 5xx, unhealthy tasks, p95 latency, running tasks (below desired with Container Insights, below the minimum without), CPU, and memory per service, database CPU, storage, and memory, plus RDS low-storage events (including storage autoscaling at its ceiling) and an EventBridge rule that sends unplanned ECS task stops (crash loops) to the topic. Trust alarms on the worker's metrics (namespace `Listora`): an operation unverified for 30 minutes, any failed delist, an account's AI cost today over `aiDailyCostAlarmUsd`, a connection that needs relinking (a level alarm that suits one seller; multi-seller environments should switch to alarming on increases), and per marketplace, p95 delist latency over an hour above `delistLatencyAlarmMinutes` and a verified-success rate below 90% over a day. Behind the HTTP API (personal), `api-5xx` fires on any server error in 2 of 3 five-minute periods. Log groups sit with the stacks that write them; retention is 30 days in staging and 90 in prod. |

Sizes, redundancy, retention, and the network, ingress, and service layouts per environment
are in `ENVIRONMENT_SETTINGS` (`src/config.ts`), so a change shows up in review as a code and
snapshot diff.

### The personal environment

The same stacks, image, and deploy workflow, with every hourly charge that one user does not need
removed. It costs about $35 a month, or about $36 a month with browser automation, and $0.56 more
once a domain is added; [docs/features/costs.md](../docs/features/costs.md) has the line items, the
alternatives each choice beat, and the levers left.

| Piece       | staging and prod                                              | personal                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Egress      | Tasks in private `app` subnets behind NAT gateways            | No `app` tier and no NAT: tasks run in the public subnets with a public IPv4 address, and their groups admit nothing from the internet                                                                                           |
| API ingress | HTTPS ALB at `api.<domain>`, health-checked on `/health/live` | API Gateway HTTP API (TLS 1.2+, throttled) with a VPC link to the task, found through Cloud Map (SRV): at the execute-api URL and, with a domain, at `api.<domain>` too (`disableDefaultEndpoint` turns the execute-api URL off) |
| Health      | The ALB's target health check                                 | The API container's own ECS health check on `/health/live`; the `app-running-tasks` alarm and the task-stopped rule replace the target-group alarms                                                                              |
| Services    | `api` and `worker`, each its own service and task role        | One `app` service whose task runs both containers (0.25 vCPU, 1 GiB), with one task role holding both sets of grants                                                                                                             |
| Database    | `t4g.micro` single-AZ (staging), `t4g.medium` Multi-AZ (prod) | `t4g.micro` single-AZ, 20 to 50 GiB, 7-day backups, deletion protection                                                                                                                                                          |
| Domain      | Required: the API certificate, SES inbound mail, and DKIM     | Optional: see [Without a domain](#without-a-domain)                                                                                                                                                                              |
| Logs        | Rejected-traffic flow logs; 30 or 90 days                     | No flow logs; 7 days                                                                                                                                                                                                             |

The HTTP API limits each request to 30 seconds and 10 MB. Photos upload straight to S3, so no
request comes near them. If no request passes through the VPC link for 60 days, API Gateway
removes its network interfaces, and the first request afterwards fails for a few minutes.

`browserRunner` sizes the headless-Chromium runner (1 vCPU, 4 GiB), the compute stack's
`runner` service in every environment. It runs the browser automation of decision D1 in
[docs/features/automation.md](../docs/features/automation.md) and follows its
rules: session cookies encrypted with the token key, never a password, human-paced actions,
and never a CAPTCHA or bot check solved (it stops and falls back to an assisted task).

- **On demand.** The service's desired count is 0. The worker sets it to 1 when automated
  steps or sale checks wait (`ecs:UpdateService` on that service only), and the runner sets it
  back to 0 as it exits after two idle minutes. A deploy resets it to 0; work still waiting
  starts a runner of the new release within a minute. Deployments stop the old task before a
  new one starts (minimum 0%, maximum 100%), so two runners never act at once.
- **Image.** The Dockerfile's `runner` stage: the application's files on top of Playwright's
  headless Chromium and its system libraries, which change only with the dependencies. The
  deploy workflow builds and pushes it next to the application image, with the same tag.
- **Task.** Read-only root file system with a writable `/tmp` volume for Chromium, the worker's
  network place and security group (the database, internet egress, no ingress), and
  `PGPASSWORD` only. Fargate creates that volume owned by root (mode 0755) unless the image
  declares its path a `VOLUME`, so the runner stage declares `/tmp` one, owned by the
  unprivileged user the runner runs as; without it Chromium cannot start. A test checks that
  the image declares every path the task mounts, and the container smoke test runs the runner
  on the image's own volume instead of a tmpfs.

**The iPhone app.** The personal environment is the production environment for now, so the
iOS `Prod-Release` configuration's `API_BASE_URL` points at it (there is no separate Personal
build configuration). The app's endpoint is the compute stack's `ApiUrl` output, set at the
first deploy (step 8 below): `https://api.<domain>` with a domain, or the HTTP API's
`https://<id>.execute-api.<region>.amazonaws.com` without one.

#### Without a domain

Personal deploys with no domain and no Route 53 hosted zone (leave `domain` and
`hostedZoneId` unset), so a domain can be added later. Staging and prod always need one: a
load balancer serves only `api.<domain>`. Without a domain:

- **API.** The HTTP API's default `execute-api` endpoint stays on and is the `ApiUrl` output.
  AWS serves it over TLS with its own certificate. No hosted zone, certificate, custom domain,
  or DNS record is created, so none of them costs anything.
- **Photos.** Marketplaces fetch listing photos from the CloudFront distribution's own
  `*.cloudfront.net` domain (the storage stack's `PhotoCdnDomain` output), with or without a
  domain.
- **Sales.** SES receives mail only for a verified domain, so email-forwarded sale detection
  is off: the email stack holds only its empty bucket, with no SES identity, MX record, receipt
  rules, topic, or queue, and the containers run with `EMAIL_INGEST=off` (the app shows the
  sale emails section as not available yet). Sales are still detected by the scheduled
  automation checks (about every 12 hours) and by marketplace API webhooks; forwarded sale
  emails are enabled once a domain is added
  ([docs/features/email-sales.md](../docs/features/email-sales.md)).

**Adding a domain later.** Without a domain, every URL registered with a third party points
at the execute-api URL: the marketplace OAuth redirect (`/v1/connections/{marketplace}/callback`,
the eBay RuName accept URL and the Depop redirect URI), marketplace sale webhooks, and Stripe
and App Store Server Notifications. Adding the domain keeps the execute-api URL on, so none of
them breaks; turning it off is a separate, later step:

1. Create the hosted zone (step 1), set `DOMAIN` and `HOSTED_ZONE_ID` in the GitHub
   environment, and run the Deploy workflow. That deploy adds `https://api.<domain>` (now the
   `ApiUrl` output) and the SES inbound pieces; the execute-api URL keeps serving.
2. Re-register every third-party URL above at `https://api.<domain>`: the eBay RuName accept
   URL, the Depop redirect URI, each marketplace's webhook endpoints, the Stripe webhook
   endpoint, and the App Store Server Notifications URL.
3. Set the new `ApiUrl` in the app (step 8) and ship a TestFlight build.
4. Activate the receipt rule set (step 6). Each account's forwarding address (Settings > Link
   accounts > Sale emails) is then at `in.<domain>`, and the containers read sale emails
   (`EMAIL_INGEST=ses`).
5. Confirm everything works at the new URL: connect a marketplace, see a webhook and a Stripe
   and App Store notification arrive, and check that the app in use is the new build.
6. Only then, optionally, set `disableDefaultEndpoint: true` in personal's `ingress`
   (`src/config.ts`), refresh the snapshots, and deploy, so only `https://api.<domain>`
   serves the API. A URL still registered at the execute-api URL fails from that deploy on.

### How the pieces connect

- **Database credentials.** `DATABASE_URL` names the host, port, database, and user but no
  password. ECS injects `PGPASSWORD` from the RDS secret, and node-postgres uses it for a URL
  without a password. TLS is verified (`sslmode=verify-full`) against the RDS certificate
  bundle that the image installs.
- **Container configuration.** `src/containers.ts` is the only place the container
  environment is defined. `containers.test.ts` runs the API's, worker's, and runner's real
  config loaders on it, so a task that adds a required config key fails the tests until it
  adds the key there. The worker and the runner get the runner service's cluster and name
  (`BROWSER_RUNNER_*`), and the runner the token key's ARN (`TOKEN_KMS_KEY_ID`) and the photo
  bucket for its screenshots.
  The API and the worker share the photo bucket (`STORAGE_DRIVER=s3`, with the bucket, its
  region, and the CloudFront URL from the storage stack): the API stores uploads, and the
  worker processes and analyzes them. Both call the Anthropic API (`AI_PROVIDER=anthropic`)
  with the `anthropic-api-key` secret, which must be set by hand before analyses succeed;
  until then they fail visibly with the reason.
- **Task roles (least privilege).** Both services: read and write the photo bucket, and
  `kms:GenerateDataKey` on the token key (`TOKEN_KMS_KEY_ID`), to seal marketplace credentials.
  Worker only: `kms:Decrypt` on the token key for OAuth tokens only (the encryption context
  purpose `listora-marketplace-tokens`; only the worker opens tokens, at use time), read and
  delete raw sale email under `inbound/` and consume the sale email queue (with a domain), and
  start the browser runner (`ecs:UpdateService` on the
  `runner` service). The runner: `kms:Decrypt` and `kms:GenerateDataKey` for browser sessions
  only (the purpose `listora-marketplace-session`), put objects under `automation/`
  (screenshots), and scale its own service to zero. A combined task's role holds both
  services' grants. Each service can read only its own secrets. These grants are the designed
  access for T-07 (storage), T-16 (token vault), T-23 (email ingest), and the browser runner,
  which add their config keys to `src/containers.ts`. eBay connects once an environment has an
  eBay keyset (`EBAY_ENV`, `EBAY_CLIENT_ID`, `EBAY_RUNAME`, and an `EBAY_CLIENT_SECRET`
  secret), which the eBay go-live task adds (T-35); until then the app shows eBay as "Coming
  soon".
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

| Command                                  | What it does                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run infra:synth`                    | `cdk synth` for every environment, plus personal with a domain, with placeholder settings and AWS credentials hidden (offline)              |
| `npx vitest run --project unit infra`    | Infra tests: config, assertions per stack and environment, template snapshots, deploy and TestFlight workflows                              |
| `npx vitest run --project unit infra -u` | Refresh the template snapshots in `src/__snapshots__/` after an intended change; review the diff                                            |
| `scripts/deploy-personal.sh --dry-run`   | The personal deploy's offline checks and the steps it would run ([Deploying the personal environment](#deploying-the-personal-environment)) |

Commands that talk to AWS (`cdk diff`, `cdk deploy`) run from `infra/` with that account's
credentials and the settings below, for example `npx cdk diff -c env=staging`.

## Settings

Account ids and domains are never committed, except the personal account that
`scripts/deploy-personal.sh` pins so that it cannot deploy anywhere else. `loadDeployTarget` reads each setting from CDK
context (`-c key=value`) or else an environment variable (all documented in `.env.example`),
and fails fast, naming the missing or invalid key without printing its value.

| Context key         | Environment variable         | Required | Meaning                                                          |
| ------------------- | ---------------------------- | -------- | ---------------------------------------------------------------- |
| `env`               | `LISTORA_ENV`                | yes      | `staging`, `prod`, or `personal`                                 |
| `account`           | `LISTORA_AWS_ACCOUNT_ID`     | yes      | The environment's 12-digit AWS account id                        |
| `region`            | `LISTORA_AWS_REGION`         | no       | Default `us-east-1`; SES must receive email there                |
| `domain`            | `LISTORA_DOMAIN`             | yes      | For example `staging.listora.app`; optional for personal         |
| `hostedZoneId`      | `LISTORA_HOSTED_ZONE_ID`     | yes      | Route 53 public hosted zone for `domain`; set with `domain`      |
| `imageTag`          | `LISTORA_IMAGE_TAG`          | yes      | Image tag to run (the commit SHA); `latest` is refused           |
| `alarmEmail`        | `LISTORA_ALARM_EMAIL`        | no       | Subscribed to the alarm topic                                    |
| `ownerEmail`        | `LISTORA_OWNER_EMAIL`        | personal | The only person who can sign in (owner pool); refused elsewhere  |
| `githubRepository`  | `LISTORA_GITHUB_REPOSITORY`  | no       | Repository allowed to deploy; default `toniojbusiness/listora`   |
| `availabilityZones` | `LISTORA_AVAILABILITY_ZONES` | no       | Two zones of the region, comma-separated; default: the first two |

## Deploying the personal environment

The personal environment deploys from a Mac with one command, `scripts/deploy-personal.sh`,
instead of the Deploy workflow: no GitHub environment, OIDC role, or `deploy-access` stack is
involved. It deploys only to the captain's account `976033325938` (pinned in the script; any
other account is refused) and runs the same steps in the same order as the workflow.

**Before the first run:** sign in to the account's AWS CLI profile (for example
`aws sso login --profile prequal-main`; one sign-in covers the whole deploy, since `cdk` gets
the profile's credentials from the AWS CLI through `credential_process` in a private config the
script removes on exit, instead of the hour-long SSO token `cdk` cannot renew), start Docker (`LISTORA_CONTAINER_CLI=finch` uses Finch
instead), and put the Anthropic key in `~/.config/listora/anthropic.env` as one
`ANTHROPIC_API_KEY=...` line. Export `LISTORA_OWNER_EMAIL`, the address you sign in to the app
with: the user pool's only user (docs/features/auth.md, The owner pool). Optional settings (`LISTORA_AWS_REGION`,
`LISTORA_AVAILABILITY_ZONES`, `LISTORA_ALARM_EMAIL`, `LISTORA_DOMAIN` with
`LISTORA_HOSTED_ZONE_ID`) come from the environment, as for `cdk` ([Settings](#settings)).

```sh
scripts/deploy-personal.sh --dry-run --profile prequal-main   # offline: checks and prints every step
scripts/deploy-personal.sh --profile prequal-main             # deploys
```

From a clean checkout of the commit to deploy (the image is tagged with it), the script:

1. **Checks locally**: the tools, a clean checkout, `LISTORA_OWNER_EMAIL`, and the Anthropic
   key file (never printed).
2. **Verifies the account**: `aws sts get-caller-identity` must be `976033325938`.
3. **Checks the zones and the stacks**: refuses `use1-az3` (no API Gateway VPC links) and
   suggests a `LISTORA_AVAILABILITY_ZONES` value; refuses any stack that is busy, failed, or
   `ROLLBACK_COMPLETE`, so it never deletes or replaces something that exists.
4. **Synthesizes offline** with the real settings into `infra/cdk.out/deploy-personal` and
   deploys exactly that assembly. It checks the templates first: the database has deletion
   protection, the API's `AUTH_DRIVER` is `cognito` (the dev driver is refused), the user pool
   allows no sign-up and its only user is `LISTORA_OWNER_EMAIL`, and `AI_PROVIDER` is not
   `fake`.
5. **Makes sure Listora's own CDK bootstrap is the restricted one**
   ([Trust boundary](#trust-boundary)). Listora bootstraps separately from any other CDK app
   in the account: qualifier `listora` and toolkit stack `CDKToolkit-listora`
   (`src/bootstrap.ts`; `cdk.json` makes every `cdk` command use them), so the account's
   default `CDKToolkit` and the apps deploying through it are never touched. The script first
   checks `CDKToolkit-listora`: one with any other execution policy stops it before it changes
   anything. Then it creates the managed policy `listora-personal-cdk-execution` from
   `src/deploy/execution-policy.ts` (or makes the committed document its default version), and
   bootstraps when `CDKToolkit-listora` does not exist yet with:

   ```sh
   npx cdk bootstrap aws://976033325938/us-east-1 --profile prequal-main \
     --qualifier listora --toolkit-stack-name CDKToolkit-listora \
     --cloudformation-execution-policies arn:aws:iam::976033325938:policy/listora-personal-cdk-execution \
     --termination-protection
   ```

6. **Deploys** the registry, builds the `app` and `runner` images for `linux/amd64` (the
   tasks run on X86_64) and pushes them (reusing an image already pushed for the commit), then
   the state stacks and the migrate stack.
7. **Waits until SES has verified the owner's address** (and, with a domain, the domain), then
   deploys the auth stack (the user pool). The pool emails the sign-in codes through SES, which
   sends only to verified addresses while the account is in the SES sandbox. **The one manual
   step:** on the first deploy, the email stack makes the owner's address an SES identity and
   AWS emails it "Amazon Web Services - Email Address Verification Request"; click its link
   while the script waits (30 minutes at most; run the script again after that). No email?
   `aws ses verify-email-identity --email-address <owner> --profile <profile>` sends it again.
   Later deploys find it verified and go straight on. If the account already has the owner's
   address as an SES identity that no Listora stack owns, the script leaves it alone
   (`ownerEmailIdentity=existing`, `LISTORA_OWNER_EMAIL_IDENTITY`) and only waits until it is
   verified, since CloudFormation cannot create an identity that already exists.
8. **Stores the Anthropic key** in `listora/personal/anthropic-api-key` from a private
   temporary file, only when it differs; if the services were already running, it restarts
   them so they read it.
9. **Runs the migrations** (`scripts/run-migrations.sh`, the workflow's step), then deploys
   compute and observability.
10. **Waits for health** (`/health/ready` with the database ok, 10 minutes at most), runs the
    **smoke test**, and prints the API URL and the app client id to put in the iPhone app's
    Prod configuration.

**Smoke test** (`src/deploy/smoke.ts`, also runnable on its own): `/health/live` and
`/health/ready`, a `401` for a request without a token, a sign-in with the configured driver,
then it creates a draft item, reads it, deletes it, and checks that it is gone. With the `dev`
driver it requests a code, reads it from the API's log group, and finally deletes the
throwaway account it signed in to. With `cognito` it also checks that the dev sign-in is off
(`404`), and signs in only with `LISTORA_SMOKE_ID_TOKEN`, an ID token of a user of the pool,
whose account it keeps. Personal's pool has one user, the owner, so the deploy runs without
one and skips the signed-in steps; to run them against your own account, pass your ID token:
`LISTORA_SMOKE_ID_TOKEN=<token> node infra/src/deploy/smoke.ts --api-url <url> --auth cognito`.
It never starts an analysis or touches a marketplace, so it costs no AI usage. A failed step
fails the deploy with the step's name.

**Point the iPhone app at it.** Set the printed values in `apps/ios/Config/Prod.xcconfig`,
keeping the `$()` that stops xcconfig from reading `//` as a comment, for example:

```text
API_BASE_URL = https:/$()/abc123.execute-api.us-east-1.amazonaws.com
COGNITO_REGION = us-east-1
COGNITO_CLIENT_ID = 1example23456789abcdefghij
```

Then ship a TestFlight build ([apps/ios/README.md](../apps/ios/README.md#environments)) and
sign in from Settings with `LISTORA_OWNER_EMAIL`: the app emails you a code. The URL changes
only when a domain is added ([Without a domain](#without-a-domain)); the client id only if the
auth stack is replaced.

**The owner's account.** The auth stack creates the owner's Cognito user, verified and without
a password, so the first sign-in is an emailed code like every later one. Changing
`LISTORA_OWNER_EMAIL` replaces that user, and the new one signs in to a new, empty Listora
account (the account belongs to the Cognito user's `sub`). Deleting the account in the app
deletes the Cognito user too; to sign in again, recreate it with
`aws cognito-idp admin-create-user --user-pool-id <UserPoolId output> --username <owner>
--user-attributes Name=email,Value=<owner> Name=email_verified,Value=true --message-action
SUPPRESS --profile <profile>`.

### Rollback

- **A failed deploy step.** The script stops at the first failure. CloudFormation rolls the
  failing stack back to its last good state by itself, and a failed migration stops the deploy
  before any new task starts, so the previous release keeps serving. Fix the cause and run the
  script again.
- **A stack that failed while being created** is left `ROLLBACK_COMPLETE` and must be removed
  before it can be created again; the script refuses to touch it. For a stack without data
  (network, migrate, compute, observability): turn off its termination protection
  (`aws cloudformation update-termination-protection --no-enable-termination-protection
--stack-name <stack>`) and remove it (`aws cloudformation delete-stack --stack-name <stack>`).
  Never do this for the data stack without checking what it holds.
- **A bad release.** Check out the last good commit and run the script again: its image is
  still in ECR, so nothing is rebuilt, and because migrations are expand-then-contract, the
  older code runs on the newer schema. Do not revert migrations in the deployed database.
- **A bad Anthropic key.** Fix `~/.config/listora/anthropic.env` and run the script again.

### Teardown

Removing the personal environment destroys its data; there is no undo except the final
database snapshot. Remove the stacks in reverse order (observability, compute, auth, email,
storage, migrate, data, secrets, network, registry), turning off each stack's termination
protection first. The user pool has deletion protection and is retained: turn the protection
off (`aws cognito-idp update-user-pool --deletion-protection INACTIVE ...`) and delete it by
hand. Before the data stack:

- **The database has deletion protection.** Turn it off on purpose, or removing the stack
  fails: `aws rds modify-db-instance --db-instance-identifier <id> --no-deletion-protection
--apply-immediately`. Removing the stack then takes a final snapshot, which costs storage
  until you remove it.
- **Retained resources** outlive their stacks and keep costing (a little) until removed by
  hand: the photo and inbound-mail buckets, the ECR repository, the log groups, the app
  secrets, and the KMS token key (schedule its deletion; every stored marketplace token becomes
  unreadable).

Listora's bootstrap (`CDKToolkit-listora`, termination-protected) and the
`listora-personal-cdk-execution` policy go last. Leave the account's default `CDKToolkit` alone:
other apps deploy through it.

## First deploy of an environment

Do this once per environment (staging first), with administrator credentials for that
account. The examples use staging.

1. **Accounts and DNS.** Create the account (AWS Organizations) and a Route 53 public hosted
   zone for the environment's domain (for example `staging.listora.app`, delegated from the
   parent zone). Note the account id and hosted zone id. For personal, use the reseller's own
   account and, optionally, any domain they control; without one, skip the hosted zone
   ([Without a domain](#without-a-domain)).
   **Zones.** Zone names map to different zone ids in every account, and in us-east-1 the
   zone `use1-az3` has no API Gateway VPC links (which personal needs) and no Graviton
   instances. List the first two zones with
   `aws ec2 describe-availability-zones --query 'AvailabilityZones[0:2].[ZoneName,ZoneId]'`;
   if either is `use1-az3`, pick two other zones for the `availabilityZones` setting
   (`AVAILABILITY_ZONES` in the GitHub environment). Choose them before the first deploy:
   changing zones later replaces the network and everything in it.
2. **Bootstrap CDK** in the account and region, with the restricted execution policy: create
   `listora-<env>-cdk-execution` from `node src/deploy/execution-policy.ts <env> <account>`
   (`aws iam create-policy --policy-name listora-<env>-cdk-execution --policy-document
file://policy.json`), then from `infra/`:
   `npx cdk bootstrap aws://<account>/us-east-1 --qualifier listora --toolkit-stack-name
CDKToolkit-listora --cloudformation-execution-policies
arn:aws:iam::<account>:policy/listora-<env>-cdk-execution --termination-protection`
   (Listora's own bootstrap, beside any other app's; `src/bootstrap.ts`). The
   bootstrap's CloudFormation execution policy is the ceiling on what any deploy can change;
   see [Trust boundary](#trust-boundary). It allows no OIDC provider, so `deploy-access`
   (step 3) cannot deploy through this bootstrap, by design: the administrator deploys its
   synthesized template with plain CloudFormation (`aws cloudformation deploy`). The personal
   environment needs neither: `scripts/deploy-personal.sh` does steps 2, 5, and 7
   ([Deploying the personal environment](#deploying-the-personal-environment)).
3. **Deploy access.** From `infra/`, with the settings exported (or as `-c` flags):
   `npx cdk deploy listora-staging-deploy-access`. If the account already has the GitHub OIDC
   provider, remove it first or import it; an account can have only one per URL.
4. **GitHub environment.** In the repository settings create the environment `staging` (and
   later `prod`, or `personal` for a personal deployment) with protection rules: required
   reviewers, and deployment branches limited to `main`. Add the environment variables
   `AWS_ACCOUNT_ID`, `AWS_REGION`, `DOMAIN`,
   `HOSTED_ZONE_ID`, and optionally `ALARM_EMAIL` and `AVAILABILITY_ZONES` (personal without a
   domain leaves out `DOMAIN` and `HOSTED_ZONE_ID`; personal also needs `OWNER_EMAIL`, the one
   person its user pool lets sign in). No secrets are needed. Deploy personal the first time
   with `scripts/deploy-personal.sh`, which waits for the owner to click SES's verification
   link before it deploys the user pool; the workflow's user pool step does not wait.
5. **Deploy.** Run the **Deploy** workflow (Actions tab) on `main` with `staging`. It tests
   and synthesizes offline, assumes the deploy role through OIDC, deploys the registry, builds
   and pushes the application and runner images tagged with the commit, deploys the state
   stacks and the migrate stack, runs the schema migrations (on a first deploy, every
   migration from an empty database), and only then deploys compute and observability. With a
   domain, ACM and SES
   validate through the hosted zone, so the first run waits for DNS. If the migrations fail,
   the workflow stops before any new task starts; the task's logs are in
   `/listora/<env>/migrate`.
6. **Activate the SES receipt rule set** (with a domain only; one per account and region can
   be active, and CloudFormation cannot activate it):
   `aws ses set-active-receipt-rule-set --rule-set-name listora-staging`. Request SES
   production access if the account will send email.
7. **Set the app secrets.** Each secret in `APP_SECRETS` starts with a random placeholder.
   Set real values with `aws secretsmanager put-secret-value --secret-id
listora/staging/<name> --secret-string ...`, then redeploy or force a new ECS deployment so
   tasks read them.
8. **Point the iPhone app at it (personal only).** Read the compute stack's `ApiUrl` output
   (`https://api.<domain>`, or the execute-api URL without a domain):
   `aws cloudformation describe-stacks --stack-name listora-personal-compute --query
"Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text`. Set it as
   `API_BASE_URL` in `apps/ios/Config/Prod.xcconfig` (see
   [apps/ios/README.md](../apps/ios/README.md#environments)) before the next TestFlight build,
   and `COGNITO_CLIENT_ID` from the auth stack's `AppClientId` output (`COGNITO_REGION` is the
   region).
   Run this again whenever the URL changes (adding a domain later changes it; see
   [Adding a domain later](#without-a-domain)).

Later deploys are step 5 only.

## Trust boundary

The deploy role can assume the CDK bootstrap roles, and the bootstrap's CloudFormation
execution role can do whatever the bootstrap's execution policy allows (`AdministratorAccess`
unless the bootstrap restricted it). What actually bounds a deploy:

- the GitHub environment's protection rules (required reviewers, `main` only), which decide
  who can run a job that assumes the role, and
- the bootstrap's CloudFormation execution policy, which decides what that job can change.

**The restricted execution policy** (`src/deploy/execution-policy.ts`, managed policy
`listora-<env>-cdk-execution`) replaces `AdministratorAccess`. It grants every action of the
services the stacks use (`SERVICE_PREFIXES`; a test fails when a stack adds a resource of
another service), IAM only on roles named `listora-<env>-*` (attaching only the listed AWS
managed policies) and on service-linked roles, and it denies any change to the GitHub deploy
role, the bootstrap's roles, and the bootstrap bucket's policy. It grants nothing on IAM
users, groups, OIDC providers, Organizations, or account settings, so a deploy can no longer
rewrite the deploy role's own permissions. Every environment bootstraps with it (step 2).

**Follow-up (T-33, security hardening):** a permissions boundary on every role the stacks
create, since a stack's own role can still be given any inline permission, and scoping the
service grants to Listora's tagged resources: they are service-wide, and the personal account
also holds another app's stacks.

## Conventions

- Stacks extend `ListoraStack` (`src/stacks/common.ts`), which resolves availability zones at
  deploy time instead of looking them up, so synthesis never calls AWS. Never use `fromLookup`
  methods; pass ids through settings instead. `npm run infra:synth` hides AWS credentials, so
  a lookup fails there.
- `cdk.json` holds the app command and the CDK feature flags recommended for new projects;
  the tests load the same flags.
- The TypeScript settings are the repository's, except `exactOptionalPropertyTypes`, which
  aws-cdk-lib's own types do not support.

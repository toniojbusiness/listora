# Alerts, the weekly summary, and backups

How the operator hears that something is wrong, and how the database is backed up and restored.
The alarms themselves and the metrics they read are in [observability.md](observability.md);
this page covers how they reach a person, the extra signals added for that, and the backups.

Code: `packages/alerts` (`@listora/alerts`: the emails, the summary, the mailer, the Lambda
handlers, and `bundle.ts`, which bundles them with rolldown), and in infra the
`AlertEmails` construct (`infra/src/stacks/alerts.ts`) plus the deploy, budget, and heartbeat
signals in `infra/src/stacks/observability-stack.ts`.

## What emails the operator gets

Every alarm and AWS event below goes to the environment's alarm topic (`listora-<env>-alarms`).
The `alert-email` function emails each message on it through SES; nothing else subscribes.

| Signal                              | Source                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| API error spikes                    | `api-5xx` (and `load-balancer-5xx` behind an ALB), `api-latency-p95`                                           |
| The worker stopping                 | `worker-heartbeat` (no trust metrics for 15 minutes), `<service>-running-tasks`, and every unplanned task stop |
| Sale checks failing or stalling     | `sale-checks-unhealthy` (a connection's checks fail or are overdue, [activity.md](activity.md))                |
| A background read failing again     | The worker's own email, naming the marketplace, read, step, and error ([read-health.md](read-health.md))       |
| A failed deploy                     | `listora-<env>-stack-failed`, `-service-deployment-failed`, and `-migration-failed` EventBridge rules          |
| AWS cost over the month's budget    | The AWS Budget `listora-<env>-monthly-cost` (`monthlyCostAlarmUsd`): actual cost over it, or forecast to be    |
| Everything else in observability.md | Delist failures and latency, unverified operations, relinks, AI cost, deletions, database CPU, storage, memory |
| The week's health                   | The `weekly-summary` function, every Monday at 14:00 UTC                                                       |

Each alarm email is sent when the alarm fires and again when it recovers ("Recovered: ...").
Subjects start with `[Listora <env>]` and name the alarm (`ALARM: worker-heartbeat`), so an
inbox rule can sort them.

## How it works

- **Outside the application.** Both functions run in Lambda outside the VPC, from the bundle
  infra builds at synthesis (`packages/alerts/src/bundle.ts`; the asset hash is the bundle's
  content). They need neither the API, the worker, nor the database, so the alert that the
  worker stopped still goes out. They read only metrics, alarms, cost, and the database's
  backup status, never application data.
- **SES, from a verified identity.** The sender is `alerts@<domain>` (the email stack's domain
  identity) where the environment has a domain, otherwise the owner's address (personal), which
  the email stack already verified for the sign-in codes. In the SES sandbox SES sends only to
  verified addresses, so the recipient must be one too; the owner is. The functions may send
  only from that sender (`ses:FromAddress`). No SNS email subscription is used: it would need
  a confirmation click and send raw JSON.
- **Who gets them.** The deploy target's `alarmEmail` (`LISTORA_ALARM_EMAIL`), which defaults to
  the owner (`LISTORA_OWNER_EMAIL`) where there is one. Without either, there is no alert
  function and alarms only change state in CloudWatch.
- **Never lost quietly.** A send that fails throws, so Lambda retries the delivery (SNS invokes
  asynchronously: two retries). A message of an unknown shape is sent as it came.
- **Worker heartbeat.** The worker publishes `OldestUnverifiedOperationAge` once a minute
  whatever the state, so its sample count is a heartbeat: `worker-heartbeat` fires after three
  5-minute periods with none, and treats missing data as breaching. It catches a worker whose
  task runs but whose jobs do not (stuck, or no database), which the running-tasks alarm cannot.
- **Failed deploys.** EventBridge sends three AWS service events to the topic: a
  `listora-<env>-*` stack that ends in a failed or rolled-back status, an ECS deployment the
  circuit breaker rolled back (which code-only deploys rely on), and a migration task started
  by a deploy (`startedBy` `deploy-*`, scripts/run-migrations.sh) that did not exit 0. A failed
  GitHub Deploy workflow also emails whoever started it, from GitHub.
- **Cost.** The budget covers the whole AWS account, including any other app in it: Listora's
  `project` cost allocation tag is not activated, and a budget filtered on an inactive tag reads
  $0 and never fires. Thresholds: staging $150, prod $600, personal $50 (about $37 is expected,
  [costs.md](costs.md)).
- **The weekly summary.** One email: what needs attention first (alarms firing now, a worker
  that reported in under 99% of the week's minutes, failed delists, a marketplace under 90%
  verified success, cost over the budget, backups off, deletion protection off, or
  point-in-time restore more than 15 minutes behind), then the week's alarm firings, each
  marketplace's settled operations, verified-success rate, and p95 delist latency, the worker,
  AWS cost this month and last, and the backup status. Its subject says "all healthy" or how
  many things need attention. A section it could not read (a missing permission, an outage) is
  reported as unread and counts as needing attention, never as healthy.

## Local development

Nothing here needs a credential. `RecordingMailer` stands in for SES and a fake `HealthReader`
for AWS; `packages/alerts/src/alerts.test.ts` drives the alert and summary functions with them,
and `bundle.test.ts` builds the bundle. `npm run infra:synth` builds the bundle offline.

## What each alert asks of you

| Alert                                                       | First steps                                                                                                                            |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `worker-heartbeat`, `<service>-running-tasks`, a task stop  | ECS console: is the task running, and why did the last one stop? Its log: `/listora/<env>/worker`.                                     |
| `api-5xx`, `load-balancer-5xx`, `api-latency-p95`           | The API log for `"level":50` lines and their `requestId`; `/health/ready` for the database.                                            |
| `sale-checks-unhealthy`                                     | `scripts/admin-remote.sh <env> -- sale-checks` names the connection and its last error ([activity.md](activity.md)).                   |
| A read failed N times in a row, or has not worked for hours | `scripts/admin-remote.sh <env> -- read-health --account <id>`: each read's last success and error ([read-health.md](read-health.md)).  |
| `operation-unverified`, `delist-failed`, `delist-latency-*` | `scripts/admin-remote.sh <env> -- activity` on the operation; a failed delist means the item may still be for sale there.              |
| Deploy failed (stack, ECS rollback, migrations)             | The previous release keeps serving. Read the stack's events or `/listora/<env>/migrate`, fix, and deploy again ([infra.md](infra.md)). |
| AWS Budgets                                                 | Cost Explorer by service for the month; the usual suspects are a runner left running and log volume ([costs.md](costs.md)).            |
| Database event, `database-*`                                | RDS console; storage at its autoscaling ceiling means raising `maxAllocatedStorageGiB`.                                                |

## Backups

The data stack (`infra/src/stacks/data-stack.ts`) keeps automated RDS backups with
point-in-time restore: 7 days in staging and personal, 30 in prod (`backupRetentionDays`), in
the 07:00-08:00 UTC window. Deletion protection is on in prod and personal (`protectData`), and
removing the instance from the stack takes a final snapshot. Storage and backups are encrypted.

Verified on the personal environment on 2026-10-27 (`aws rds describe-db-instances`): backups
kept 7 days, the latest restorable time a few minutes behind the present, deletion protection
on, storage encrypted. The weekly summary checks the same each week.

### Restoring the database

A restore creates a new instance; RDS never overwrites the one it restores from. The steps,
for `<env>` (all with the account's profile, `--profile <profile> --region us-east-1`):

1. Read what the restored instance must match:

   ```sh
   aws rds describe-db-instances --db-instance-identifier listora-<env> --query \
     'DBInstances[0].[DBSubnetGroup.DBSubnetGroupName,VpcSecurityGroups[0].VpcSecurityGroupId,DBParameterGroups[0].DBParameterGroupName,DBInstanceClass,LatestRestorableTime]'
   ```

2. Restore to a new instance, at a time (`--restore-time 2026-10-27T19:00:00Z`) or the latest
   restorable one, into the same subnet group, security group, and parameter group (about 20
   minutes for the personal database):

   ```sh
   aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier listora-<env> \
     --target-db-instance-identifier listora-<env>-restored --use-latest-restorable-time \
     --db-instance-class <class> --db-subnet-group-name <subnet group> \
     --vpc-security-group-ids <security group> --db-parameter-group-name <parameter group> \
     --no-publicly-accessible --tags Key=project,Value=listora Key=environment,Value=<env>
   aws rds wait db-instance-available --db-instance-identifier listora-<env>-restored
   ```

   It keeps the source's password (the `listora/<env>/database` secret) and encryption key.

3. Check that it reads. The database is reachable only from the tasks' security group, so run
   the migration task (`listora-<env>-migrate`) with its `DATABASE_URL` pointed at the restored
   host and a read-only command, as `scripts/admin-remote.sh` does: take the task definition's
   `DATABASE_URL`, replace the host, and pass it and the command as container overrides to
   `aws ecs run-task` with the migrate stack's subnets, security group, and public-IP setting.
   The drill's command counted every table's rows and read the newest `operation_event`.
4. To put it in service, swap the names, so the stacks and every task's `DATABASE_URL` point
   at it unchanged: stop the services (desired count 0), rename the old instance
   (`modify-db-instance --db-instance-identifier listora-<env> --new-db-instance-identifier
listora-<env>-old --apply-immediately`), rename the restored one to `listora-<env>`, turn on
   its deletion protection and backup retention to match the stack, and start the services.
   Keep the old instance (its deletion protection stays on) until the restored one has served
   for a while; deleting it is a separate, deliberate step.

### Restore drill, 2026-10-27 (personal)

Steps 1 to 3 above, against `listora-personal`, to a temporary `listora-personal-restore-drill`
(no deletion protection, no backups of its own, tagged `purpose=restore-drill`):

- The restore started at 19:30 UTC to the latest restorable time, 19:20:52 UTC, and the instance
  was available at about 19:49 (about 20 minutes).
- Read from the restored instance through the migrate task: 54 tables, all 30 migrations
  applied, the newest operation event at 19:17:36 UTC (before the restore point).
- The same read of the live database matched table for table, except one `operation_event`
  written at 19:32 UTC, after the restore point.
- The temporary instance was then deleted (`delete-db-instance --skip-final-snapshot
--delete-automated-backups`). Nothing else was changed.

Run a drill like this after any change to the database's setup, and at least twice a year.

## Follow-ups

- Activate the `project` cost allocation tag and filter the budget on it, so another app in the
  personal account does not count against Listora's budget.
- Alarm on the alert function's own errors through a path that does not depend on SES (an SNS
  SMS or a second address), so a broken sender is noticed.
- A script for the restore check in step 3, if drills become regular.

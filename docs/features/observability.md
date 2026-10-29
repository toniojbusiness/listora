# Observability

What the processes log and the signals operators and alarms key on. Logging conventions every
process follows are in [architecture.md](../architecture.md#typescript-conventions).

- **Request ids.** Every API request has an id (a sane incoming `X-Request-Id`, otherwise a
  UUID) that is in the response header, in `error.requestId`, and as `requestId` on every log
  line of the request, so a support report leads straight to the server logs.
- **Unexpected failures** are a generic `500 internal_error` in the response; only the log has
  details.
- **Operation history.** Every operation transition appends an `operation_event` with a
  redacted request and response excerpt, error code, and attempt number
  ([operations.md](operations.md)).
- **Activity.** One timeline per item, operation, sale, and marketplace, from those records,
  every browser session's steps and their times, and every sale check; the app's Activity
  screen and `npm run admin -- activity` show it, and `scripts/admin-remote.sh` runs the search
  in AWS ([activity.md](activity.md)).
- **AI spend.** The worker's hourly spend check logs one `event: "ai_spend_alert"` line per
  alert and one `event: "ai_spend_check"` summary ([ai.md](ai.md)). CloudWatch metric filters
  and alarms (T-30, T-32) key on these field names, so they change only together with the
  alarms.
- **Health.** `/health/live` checks no dependency (ECS replaces tasks that fail it);
  `/health/ready` checks the database, for deploy checks and operators ([infra.md](infra.md)).

## Trust metrics and alarms

The worker publishes the product's trust metrics in CloudWatch Embedded Metric Format: JSON lines on
stdout that CloudWatch Logs turns into metrics (no agent, no API calls). `TRUST_METRICS` in
`packages/observability/src/catalog.ts` names each one, its unit, and its dimensions, and both the
worker and the CDK alarms read it. A Graphile cron job (`trust_metrics`, once a minute across all
workers, filled in for up to an hour after downtime) computes them from committed rows, so a
rolled-back change is never counted and every writer (worker steps, user confirmations through the
API) is covered. For minute T it publishes the operations that settled in [T - 2 min, T - 1 min):
`VerifiedSuccess` (1 or 0 per settled operation but a scheduled refresh,
[listing-refresh.md](listing-refresh.md), so Average is the verified-success rate) per
marketplace and kind and per marketplace, `OperationFailed` per marketplace and kind,
`DelistFailed`, `DelistLatency` from the recorded sale to the verified delist per marketplace
(p50, p95), and `DelistEverywhereLatency` from the recorded sale to the last of its delists, once
every one succeeded (one sample per sale; the target is under a minute,
[auto-delist.md](auto-delist.md#speed)). Every scheduled tick, however late, also publishes the state at the time it runs (the
job runs ahead of every operation step in the queue, so a backlog cannot silence it):
`OldestUnverifiedOperationAge`, `AiDailyCostUsd` per account (UTC day), `ConnectionsNeedingRelink`,
`UnhealthySaleChecks` (one value per marketplace that has any, with the marketplace as a log field:
working automation connections whose sale checks fail or stopped running,
[activity.md](activity.md)), and `OverdueDeletions`. The breakdowns no alarm reads are log-only
(no `dimensionSets` in the catalog): the same line without the EMF directive, so CloudWatch bills no
metric for them and Logs Insights still reads them. They are `StuckOperations` and
`OldestStuckOperationAge` per status (verifying, retrying, needs_user_action) and
`MarketplaceConnections` per marketplace and status, for example
`filter ispresent(StuckOperations) | stats max(OldestStuckOperationAge) by Status, bin(1h)`. The observability stack alarms on an
operation unverified for 30 minutes, any failed delist, an account's AI cost today over
`aiDailyCostAlarmUsd`, a connection needing relink, any connection whose sale checks fail or stopped
running (`sale-checks-unhealthy`), and per marketplace on p95 delist latency over
an hour above `delistLatencyAlarmMinutes` (10 minutes for eBay's API, 13 hours for the
browser-automated marketplaces and their 12-hour sale checks) and a verified-success rate below 90%
over a day, on any account or connection deletion unfinished after 8 days (`OverdueDeletions`,
[privacy.md](privacy.md)), and on every service running fewer tasks than it should, and sends unplanned task stops
to the alarm topic. The relink alarm fires on a level, which suits one seller; an environment with
many sellers should alarm on increases instead, so one unlinked connection does not mask the next. A
new metric adds a catalog entry; keep dimensions few, since CloudWatch bills each combination of
values as a metric ([costs.md](costs.md)), and make a breakdown no alarm reads log-only. A `worker-heartbeat` alarm fires when the worker publishes no
trust metrics for 15 minutes, and every alarm, failed deploy, and cost-budget notice is emailed to the
operator, with a weekly health summary ([alerts.md](alerts.md)).

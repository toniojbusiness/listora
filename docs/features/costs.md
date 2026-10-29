# Monthly cost of the personal environment

The `personal` environment (`ENVIRONMENT_SETTINGS.personal` in `infra/src/config.ts`) runs
Listora for one reseller in their own AWS account. Every service runs around the clock. This
page estimates its monthly AWS bill, explains the choices that keep it low, and lists the
levers that would cut it further. The design is described in
[infra/README.md](../../infra/README.md#the-personal-environment).

**Estimate: about $40 a month, or about $41 a month with browser automation**, deployed as it
starts: without a domain
([infra/README.md](../../infra/README.md#without-a-domain)). It costs $0.56 more once a domain is
added (its Route 53 hosted zone and SES inbound sale email), plus the domain's registration.
A copy of the staging layout (NAT gateway, load balancer, two services) would cost about $100.

Rechecked on 2026-10-25 after the efficiency pass ([performance.md](performance.md)): it added
or removed no billed resource and changed no task size, so the estimate stands. The privacy
hardening ([privacy.md](privacy.md)) then added one trust metric (`OverdueDeletions`) and its
alarm, $0.40 a month, and sale-check health ([activity.md](activity.md)) another
(`UnhealthySaleChecks`) and its alarm, $0.40 a month. Alerts and backups
([alerts.md](alerts.md)) added the worker's heartbeat alarm ($0.10), the alert and weekly
summary functions, and the monthly budget, $0.14 a month in all.

On 2026-10-28 the task went from 0.25 to 0.5 vCPU (the captain's call on the efficiency audit:
the smaller task's CPU starvation was behind slow launches and photo bursts), $7.39 a month
more. No one-year commitment was taken (levers, item 4).

Measured on 2026-10-28 (the efficiency audit; Cost Explorer, CloudWatch, and the logs over 7
days, on the 0.25 vCPU task): about $34.50 to $35 a month, so about $42 with the 0.5 vCPU task.
81% of it is fixed (the database, the task, and its address). The audit's measurements replaced
the traffic, log, and runner assumptions below, and three of its fixes then lowered the bill
by about $1.80 a month:

- 12 of the 16 metrics published every minute were breakdowns no alarm reads (stuck operations
  and their ages per status, connections per marketplace and status, unhealthy sale checks per
  marketplace). They are now log fields only, for Logs Insights ([observability.md](observability.md)):
  4 metrics are published every minute, under the free 10.
- `/health/live`, the load balancer's check and 48% of all API requests, writes no request log
  lines.
- ECR keeps 15 images per repository instead of 50, and a deploy whose image inputs did not change
  tags the deployed images with the new commit instead of building and storing new ones
  (`scripts/deploy-personal.sh`; 57 runner images were pushed in 3 days before).

The cost budget (`infra/src/config.ts`) and the account's free allowances are shared with any
other workload in the same AWS account; the captain's personal account also runs another project.

Prices were read on 2026-10-24 for US East (N. Virginia), on demand, from the AWS pricing
pages linked below (the price data behind their tables). A month is 730 hours. Taxes, the
domain registration, and the Anthropic API bill are not included.

## Assumptions

- One reseller, about 500 items with 6 photos each: about 250,000 API requests a month
  (measured; 70% of them the item screen's poll while a listing is in progress) and about 0.25 GB
  of logs (measured 0.31 GB, 57% of it request lines, before `/health/live` stopped logging), plus
  300 forwarded sale emails once a domain is added.
- The worker's trust metrics (CloudWatch Embedded Metric Format, about ten small log lines a
  minute) are 37% of the logs. Four are published every minute (the oldest unverified
  operation, connections needing relink, unhealthy sale checks, and overdue deletions), the AI
  cost while an account is active, and per-marketplace operation results (per kind, and the
  verified-success rate per marketplace) only in the hours operations settle: about 10 metrics
  billed for a full month.
- Each photo stores about 2.2 MB (a full-size original plus the listing, AI, and thumbnail
  derivatives), so photos take about 7 GB, about 8 GB with replaced versions kept for 30 days.
- Marketplaces fetch listing photos well within CloudFront's always-free tier.
- The database stays within 20 GB and within its burst baseline (no CPU credit charges).
- The browser-automation runner is priced separately, by hour of use
  ([Browser automation](#browser-automation)).

## Line items

| Item                                 | Usage                                                            |    Monthly |
| ------------------------------------ | ---------------------------------------------------------------- | ---------: |
| RDS PostgreSQL `db.t4g.micro`        | Single-AZ, $0.016 an hour                                        |     $11.68 |
| RDS storage                          | 20 GB gp3 at $0.115 per GB                                       |      $2.30 |
| RDS automated backups                | 7 days; free up to the provisioned storage                       |      $0.00 |
| Fargate task (API and worker)        | 0.5 vCPU at $0.04048 and 1 GB at $0.004446 an hour (x86)         |     $18.02 |
| Public IPv4 address of the task      | 1 address at $0.005 an hour                                      |      $3.65 |
| API Gateway HTTP API                 | 250,000 requests at $1.00 per million; the VPC link is free      |      $0.25 |
| Cloud Map                            | 1 registered task at $0.10, plus its private DNS zone at $0.50   |      $0.60 |
| Route 53 public hosted zone          | None without a domain (the API uses its execute-api URL)         |      $0.00 |
| S3 photo storage and requests        | 8 GB at $0.023 per GB, 15,000 PUTs at $0.005 per 1,000           |      $0.27 |
| CloudFront                           | Within the always-free 1 TB and 10 million requests              |      $0.00 |
| SES inbound sale email               | None without a domain (SES receives only for a verified domain)  |      $0.00 |
| Cognito user pool (Essentials plan)  | 1 monthly active user; the first 10,000 are free                 |      $0.00 |
| SES sign-in codes                    | About 60 emails at $0.10 per 1,000: under a cent                 |      $0.00 |
| Secrets Manager                      | 2 secrets (database, Anthropic key) at $0.40                     |      $0.80 |
| KMS token key                        | 1 key at $1.00 (each yearly rotation adds $1, for two years)     |      $1.00 |
| CloudWatch Logs                      | 0.25 GB ingested at $0.50, kept 7 days at $0.03 per GB           |      $0.13 |
| CloudWatch custom metrics (EMF)      | About 10 metrics; the first 10 are always free, then $0.30 each  |      $0.30 |
| CloudWatch alarms                    | 23 standard alarms; the first 10 are always free, then $0.10     |      $1.30 |
| EventBridge task and deploy rules    | AWS service events delivered to SNS have no EventBridge charge   |      $0.00 |
| Alert emails and weekly summary      | 2 Lambda functions in the free tier; 4 Cost Explorer reads $0.01 |      $0.04 |
| AWS Budget                           | 1 budget; an account's first two are free                        |      $0.00 |
| ECR image storage                    | About 1 GB at $0.10 per GB (15 images kept)                      |      $0.10 |
| ACM certificate, SNS email, data out | Free (public certificates; SNS and data transfer free tiers)     |      $0.00 |
| **Total**                            |                                                                  | **$40.44** |

## With a domain

A domain adds two line items, and the API moves to `https://api.<domain>` at no extra
charge (ACM certificates and alias queries to API Gateway are free):

| Item                        | Usage                                                            |    Monthly |
| --------------------------- | ---------------------------------------------------------------- | ---------: |
| Route 53 public hosted zone | 1 zone at $0.50; alias queries to API Gateway are free           |      $0.50 |
| SES inbound sale email      | 300 emails at $0.10 per 1,000, plus 256 KB chunks at $0.09/1,000 |      $0.06 |
| **Total with a domain**     | $40.44 plus these                                                | **$41.00** |

The sale emails' SNS topic and SQS queue add nothing: SNS delivers to SQS for free, and the
worker's once-a-minute poll is about 45,000 SQS requests a month, inside the free 1 million
([email-sales.md](email-sales.md)).

With browser automation as well, the total is $41.41. The domain's registration is billed by
its registrar and is not included.

## Browser automation

Since marketplace actions and sale checks run on the seller's iPhone
([automation.md](automation.md)), only eBay's browser automation (until its API keys exist) can
use the cloud's headless-Chromium runner: it ran about 20 minutes in all in October 2026. The
runner
is reserved at 1 vCPU and 4 GB, with no task while idle (`browserRunner` in
`infra/src/config.ts`): it is the compute stack's `runner` service at a desired count of 0.
The worker sets the count to 1 when automated listing actions or sale checks wait, and the
runner sets it back to 0 as it exits, after two minutes with nothing to do
(`RUNNER_IDLE_EXIT_SECONDS`). Each seller's marketplaces are checked for sales about every
12 hours by default. The interval adapts to the seller's own sales history (sooner in the
hours and days their sales usually happen and while items are hot, later when idle) while
keeping about the same number of checks on average, and never more often than every 2 hours
(`SALE_CHECK_MIN_HOURS`). Once a domain is added, a forwarded sale email records the sale itself within
about a minute, and starts a check at once only when it cannot be matched to an item.

On demand the runner costs $0.0583 an hour (1 vCPU at $0.04048 and 4 GB at $0.004446, x86),
plus $0.005 an hour for its public address while it runs. Assumptions:

- About 2 hours a month of eBay listing actions and 2 of eBay sale checks, an upper bound well
  above the 20 minutes measured.
- The worker's dispatch task (every minute, inside the worker's task) starts the runner; it
  adds nothing to the bill.
- The runner image adds about 1.5 GB of Chromium layers to ECR, stored again only when the
  dependencies change; a release that changes the application adds its application layer, as
  the app image does.

| Item                               | Usage                                          |    Monthly |
| ---------------------------------- | ---------------------------------------------- | ---------: |
| Fargate runner, eBay listing jobs  | 2 hours at $0.0583 an hour                     |      $0.12 |
| Fargate runner, eBay sale checks   | 2 hours at $0.0583 an hour                     |      $0.12 |
| Public IPv4 address while running  | 4 hours at $0.005 an hour                      |      $0.02 |
| Worker dispatch task               | Every minute, inside the always-on worker task |      $0.00 |
| ECR storage for the Chromium image | About 1.5 GB more at $0.10 per GB              |      $0.15 |
| **Automation subtotal**            |                                                |  **$0.41** |
| **Total with browser automation**  | $40.44 plus the automation subtotal            | **$40.85** |

If the cloud ran every marketplace's listing actions and sale checks again (before on-phone
execution, about 300 listing actions and 60 checks a month: 21 hours), the subtotal would be
about $1.48. An always-on runner (one 1 vCPU / 4 GB task 24/7) would cost about $42.56 a month,
plus $3.65 for its address.

## What the design avoids

| Choice                                                         | Instead of                                                                            | Saves a month |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------: |
| Tasks in public subnets, egress through their own address      | A NAT gateway: $0.045 an hour ($32.85), its own $3.65 address, $0.045 per GB          |     about $36 |
| API Gateway HTTP API with a VPC link                           | An Application Load Balancer: $16.43, LCUs, two addresses at $7.30                    |     about $24 |
| One task running both containers (0.5 vCPU, 1 GB)              | Two tasks of 0.5 vCPU and 0.5 GB ($32.80) and a second address ($3.65)                |     about $18 |
| RDS `db.t4g.micro`, single-AZ ($13.98 with storage)            | Aurora Serverless v2: at least 0.5 ACU at $0.12 an hour ($43.80) plus storage and I/O |     about $30 |
| No rejected-traffic flow logs                                  | Logging constant internet scanner traffic at $0.50 per GB                             |      $1 to $3 |
| 7-day log retention                                            | 30 days (staging) or 90 days (prod)                                                   |         cents |
| No domain until one is wanted (the API at its execute-api URL) | A Route 53 hosted zone at $0.50                                                       |         $0.50 |

Interface VPC endpoints were also considered in place of the NAT gateway. ECR (two
endpoints), CloudWatch Logs, Secrets Manager, and KMS at $0.01 per endpoint per zone an hour
cost $36.50 in one zone, and the marketplace and Anthropic APIs would still need a way to
the internet. Aurora Serverless v2 can scale to 0 ACUs, but it pauses only when no client
holds a connection, and the API and worker always do, so it would bill its minimum all month.

What the savings give up, and why that is acceptable for one person:

- **Public addresses on tasks.** The tasks' security groups admit nothing from the internet;
  only the VPC link reaches the API port. The address is an exit, not an entrance.
- **HTTP API limits.** Requests time out after 30 seconds and carry at most 10 MB. Photos go
  straight to S3 with presigned uploads, and AI calls run in the worker, so no request needs
  more. If no request passes through the VPC link for 60 days, API Gateway deletes its network
  interfaces and the first request afterwards fails for a few minutes while they come back.
- **One task.** The API and the worker share 0.5 vCPU and 1 GB, deploy together, and share
  one task role (the union of their permissions). If either container exits, ECS replaces the
  whole task, so the API is down for about a minute.
- **One database zone.** A zone outage stops Listora until the zone recovers or the database
  is restored from a backup in another zone. Daily backups are kept 7 days, and deletion
  protection and a final snapshot guard the data.

## Levers to cut it further

1. **Free Tier credits.** New AWS accounts receive $100 in credits, and up to $100 more for
   trying foundational services, valid for up to 12 months. None were applied to the captain's
   account (October 2026): it is an existing account in an AWS organization, which may not be
   eligible. Do not count on them.
2. **Graviton Fargate.** ARM tasks cost $0.03238 per vCPU and $0.00356 per GB an hour, so the
   task drops from $18.02 to $14.42. The deploy workflow would have to build an `arm64` image
   (natively, on GitHub's free `ubuntu-24.04-arm` runner). Not done yet: a separate decision.
3. **Fargate Spot.** Up to 70% off the task (about $13 a month), but AWS can stop it with two
   minutes' notice. Sale emails and delists wait until a replacement starts, so this trades
   away the reliability of auto-delist; not recommended.
4. **Commitments.** A Compute Savings Plan covers Fargate, and an RDS reserved instance covers
   the `db.t4g.micro`, each for a one- or three-year commitment.
5. **Quieter logs.** `LOG_LEVEL=warn` cuts ingestion, already only about $0.50.

Costs to watch: the `db.t4g.micro` bills $0.075 per vCPU-hour if its average CPU stays above
its baseline for a day (unlimited burst mode; the `database-cpu` alarm fires first), photo
storage grows by about $0.02 per 100 items a month, each KMS key rotation adds $1 a month
for the first two years, alarms beyond the always-free ten cost $0.10 each (the
environment has 23: the eight platform alarms, the worker heartbeat, and the 14 trust alarms,
six plus delist latency and verified success per marketplace, which are worth more than the
$1.30), and each custom metric beyond the always-free ten costs $0.30 a month for the hours it
receives data (each AI-active account adds one). A breakdown no alarm reads belongs in the log
line, not in a metric's dimensions ([observability.md](observability.md)).

## Sources (read 2026-10-24)

- [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/)
- [Amazon RDS for PostgreSQL pricing](https://aws.amazon.com/rds/postgresql/pricing/),
  [RDS pricing](https://aws.amazon.com/rds/pricing/) (Free Tier credits), and the
  [RDS FAQs](https://aws.amazon.com/rds/faqs/) ("Free backup storage is provided up to your
  account's total provisioned database storage across the entire region")
- [Amazon Aurora pricing](https://aws.amazon.com/rds/aurora/pricing/) and
  [Aurora Serverless v2 auto-pause](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html)
- [Amazon VPC pricing](https://aws.amazon.com/vpc/pricing/) (NAT gateway, public IPv4,
  interface endpoints)
- [Elastic Load Balancing pricing](https://aws.amazon.com/elasticloadbalancing/pricing/)
- [Amazon API Gateway pricing](https://aws.amazon.com/api-gateway/pricing/),
  [HTTP API quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html),
  and [VPC links](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-vpc-links-v2.html)
- [AWS Cloud Map pricing](https://aws.amazon.com/cloud-map/pricing/)
- [Amazon Route 53 pricing](https://aws.amazon.com/route53/pricing/)
- [Amazon S3 pricing](https://aws.amazon.com/s3/pricing/)
- [Amazon CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/)
- [Amazon SES pricing](https://aws.amazon.com/ses/pricing/)
- [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/)
- [AWS Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/)
- [AWS KMS pricing](https://aws.amazon.com/kms/pricing/)
- [Amazon CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/)
- [Amazon EventBridge pricing](https://aws.amazon.com/eventbridge/pricing/) (including
  EventBridge Scheduler)
- [Amazon ECR pricing](https://aws.amazon.com/ecr/pricing/)

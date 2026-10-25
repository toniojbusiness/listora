# Monthly cost of the personal environment

The `personal` environment (`ENVIRONMENT_SETTINGS.personal` in `infra/src/config.ts`) runs
Listora for one reseller in their own AWS account. Every service runs around the clock. This
page estimates its monthly AWS bill, explains the choices that keep it low, and lists the
levers that would cut it further. The design is described in
[infra/README.md](../../infra/README.md#the-personal-environment).

**Estimate: about $35 a month, or about $36 a month with browser automation**, before any
Free Tier credit, deployed as it starts: without a domain
([infra/README.md](../../infra/README.md#without-a-domain)). It costs $0.56 more once a domain is
added (its Route 53 hosted zone and SES inbound sale email), plus the domain's registration.
A copy of the staging layout (NAT gateway, load balancer, two services) would cost about $100.

Prices were read on 2026-10-24 for US East (N. Virginia), on demand, from the AWS pricing
pages linked below (the price data behind their tables). A month is 730 hours. Taxes, the
domain registration, and the Anthropic API bill are not included.

## Assumptions

- One reseller, about 500 items with 6 photos each, light traffic: about 100,000 API
  requests and 1 GB of logs a month, plus 300 forwarded sale emails once a domain is added.
- The worker's trust metrics (CloudWatch Embedded Metric Format, about ten small log lines a
  minute) add about 0.15 GB of logs. About 14 of them are published every minute (operations
  stuck per status and their ages, the oldest unverified operation, the AI cost of each
  account active today, and the connections per marketplace and status), and per-marketplace
  operation results (per kind, and the verified-success rate per marketplace) only in the
  hours operations settle: about 16 metrics billed for a full month.
- Each photo stores about 2.2 MB (a full-size original plus the listing, AI, and thumbnail
  derivatives), so photos take about 7 GB, about 8 GB with replaced versions kept for 30 days.
- Marketplaces fetch listing photos well within CloudFront's always-free tier.
- The database stays within 20 GB and within its burst baseline (no CPU credit charges).
- The browser-automation runner is priced separately, by hour of use
  ([Browser automation](#browser-automation)).

## Line items

| Item                                 | Usage                                                           |    Monthly |
| ------------------------------------ | --------------------------------------------------------------- | ---------: |
| RDS PostgreSQL `db.t4g.micro`        | Single-AZ, $0.016 an hour                                       |     $11.68 |
| RDS storage                          | 20 GB gp3 at $0.115 per GB                                      |      $2.30 |
| RDS automated backups                | 7 days; free up to the provisioned storage                      |      $0.00 |
| Fargate task (API and worker)        | 0.25 vCPU at $0.04048 and 1 GB at $0.004446 an hour (x86)       |     $10.63 |
| Public IPv4 address of the task      | 1 address at $0.005 an hour                                     |      $3.65 |
| API Gateway HTTP API                 | 100,000 requests at $1.00 per million; the VPC link is free     |      $0.10 |
| Cloud Map                            | 1 registered task at $0.10, plus its private DNS zone at $0.50  |      $0.60 |
| Route 53 public hosted zone          | None without a domain (the API uses its execute-api URL)        |      $0.00 |
| S3 photo storage and requests        | 8 GB at $0.023 per GB, 15,000 PUTs at $0.005 per 1,000          |      $0.27 |
| CloudFront                           | Within the always-free 1 TB and 10 million requests             |      $0.00 |
| SES inbound sale email               | None without a domain (SES receives only for a verified domain) |      $0.00 |
| Secrets Manager                      | 2 secrets (database, Anthropic key) at $0.40                    |      $0.80 |
| KMS token key                        | 1 key at $1.00 (each yearly rotation adds $1, for two years)    |      $1.00 |
| CloudWatch Logs                      | 1.15 GB ingested at $0.50, kept 7 days at $0.03 per GB          |      $0.59 |
| CloudWatch custom metrics (EMF)      | About 16 metrics; the first 10 are always free, then $0.30 each |      $1.80 |
| CloudWatch alarms                    | 20 standard alarms; the first 10 are always free, then $0.10    |      $1.00 |
| EventBridge task-stopped rule        | AWS service events delivered to SNS have no EventBridge charge  |      $0.00 |
| ECR image storage                    | About 1 GB at $0.10 per GB                                      |      $0.10 |
| ACM certificate, SNS email, data out | Free (public certificates; SNS and data transfer free tiers)    |      $0.00 |
| **Total**                            |                                                                 | **$34.52** |

## With a domain

A domain adds two line items, and the API moves to `https://api.<domain>` at no extra
charge (ACM certificates and alias queries to API Gateway are free):

| Item                        | Usage                                                            |    Monthly |
| --------------------------- | ---------------------------------------------------------------- | ---------: |
| Route 53 public hosted zone | 1 zone at $0.50; alias queries to API Gateway are free           |      $0.50 |
| SES inbound sale email      | 300 emails at $0.10 per 1,000, plus 256 KB chunks at $0.09/1,000 |      $0.06 |
| **Total with a domain**     | $34.52 plus these                                                | **$35.08** |

With browser automation as well, the total is $36.56. The domain's registration is billed by
its registrar and is not included.

## Browser automation

Poshmark, Mercari, and Depop (until its partner API is granted) are automated in the cloud by
the headless-Chromium runner (decision D1 in [automation.md](automation.md)). The runner
is reserved at 1 vCPU and 4 GB, with no task while idle (`browserRunner` in
`infra/src/config.ts`), and runs as an on-demand Fargate task: one per batch of listing
actions, and one for each scheduled sale check, about every 12 hours by default (the
automation tasks will later adapt the interval to the seller's sales history). Once a domain
is added, forwarded sale emails also detect sales between checks, almost immediately.

On demand the runner costs $0.0583 an hour (1 vCPU at $0.04048 and 4 GB at $0.004446, x86),
plus $0.005 an hour for its public address while it runs. Assumptions:

- About 60 scheduled checks a month at about 6 billed minutes each (task startup, then all
  three marketplaces checked at human pace): 6 hours.
- About 300 listing actions a month (creates, edits, delists), batched into jobs that total
  about 15 hours.
- One EventBridge Scheduler schedule starts the checks, within its free tier.
- The Chromium image adds about 1.5 GB to ECR.

| Item                               | Usage                                              |    Monthly |
| ---------------------------------- | -------------------------------------------------- | ---------: |
| Fargate runner, scheduled checks   | 6 hours at $0.0583 an hour                         |      $0.35 |
| Fargate runner, listing jobs       | 15 hours at $0.0583 an hour                        |      $0.87 |
| Public IPv4 address while running  | 21 hours at $0.005 an hour                         |      $0.11 |
| EventBridge Scheduler              | 60 invocations, within the free 14 million a month |      $0.00 |
| ECR storage for the Chromium image | About 1.5 GB more at $0.10 per GB                  |      $0.15 |
| **Automation subtotal**            |                                                    |  **$1.48** |
| **Total with browser automation**  | $34.52 plus the automation subtotal                | **$36.00** |

An always-on runner (one 1 vCPU / 4 GB task 24/7) is the alternative if per-job startup ever
gets in the way: about $42.56 a month, plus $3.65 for its address. Listing jobs scale with
listing volume, at about $0.06 an hour of browser work.

## What the design avoids

| Choice                                                         | Instead of                                                                            | Saves a month |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------: |
| Tasks in public subnets, egress through their own address      | A NAT gateway: $0.045 an hour ($32.85), its own $3.65 address, $0.045 per GB          |     about $36 |
| API Gateway HTTP API with a VPC link                           | An Application Load Balancer: $16.43, LCUs, two addresses at $7.30                    |     about $24 |
| One task running both containers (0.25 vCPU, 1 GB)             | Two tasks of 0.25 vCPU and 0.5 GB ($18.02) and a second address ($3.65)               |     about $11 |
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
- **One task.** The API and the worker share 0.25 vCPU and 1 GB, deploy together, and share
  one task role (the union of their permissions). If either container exits, ECS replaces the
  whole task, so the API is down for about a minute.
- **One database zone.** A zone outage stops Listora until the zone recovers or the database
  is restored from a backup in another zone. Daily backups are kept 7 days, and deletion
  protection and a final snapshot guard the data.

## Levers to cut it further

1. **Free Tier credits.** New AWS accounts receive $100 in credits, and up to $100 more for
   trying foundational services, valid for up to 12 months: about six months of this bill.
2. **Graviton Fargate.** ARM tasks cost $0.03238 per vCPU and $0.00356 per GB an hour, so the
   task drops from $10.63 to $8.51. The deploy workflow would have to build an `arm64` image.
3. **Fargate Spot.** Up to 70% off the task (about $7 a month), but AWS can stop it with two
   minutes' notice. Sale emails and delists wait until a replacement starts, so this trades
   away the reliability of auto-delist; not recommended.
4. **Commitments.** A Compute Savings Plan covers Fargate, and an RDS reserved instance covers
   the `db.t4g.micro`, each for a one- or three-year commitment.
5. **Quieter logs.** `LOG_LEVEL=warn` cuts ingestion, already only about $0.50.

Costs to watch: the `db.t4g.micro` bills $0.075 per vCPU-hour if its average CPU stays above
its baseline for a day (unlimited burst mode; the `database-cpu` alarm fires first), photo
storage grows by about $0.02 per 100 items a month, each KMS key rotation adds $1 a month
for the first two years, alarms beyond the always-free ten cost $0.10 each (the
environment has twenty: the eight platform alarms and the twelve trust alarms, four plus delist
latency and verified success per marketplace, which are worth more than the $1.00), and each
custom metric beyond the always-free ten costs $0.30 a month
for the hours it receives data (each AI-active account adds one, each connected marketplace
status one).

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
- [AWS Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/)
- [AWS KMS pricing](https://aws.amazon.com/kms/pricing/)
- [Amazon CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/)
- [Amazon EventBridge pricing](https://aws.amazon.com/eventbridge/pricing/) (including
  EventBridge Scheduler)
- [Amazon ECR pricing](https://aws.amazon.com/ecr/pricing/)

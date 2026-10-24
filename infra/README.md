# Listora infrastructure (placeholder)

AWS infrastructure as code lives here. Plan task **T-30** creates it: AWS CDK (TypeScript)
stacks for VPC, ECS Fargate (api, worker), RDS PostgreSQL, S3 + CloudFront, SES inbound, KMS,
Secrets Manager, and alarms, plus the GitHub OIDC deploy workflow. `cdk synth` and snapshot
tests must run offline, without AWS credentials.

When T-30 adds `infra/package.json`, it also adds `infra` to the root `workspaces` list and
the root `tsconfig.json` references. See [docs/architecture.md](../docs/architecture.md).

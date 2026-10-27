import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

import type { DeployTarget, EnvironmentSettings } from '../config.ts';

/** The local part of the address alerts come from where the environment has a domain. */
export const ALERT_SENDER_LOCAL_PART = 'alerts';

/**
 * The verified SES identity alerts are sent from: `alerts@<domain>` (the email stack's domain
 * identity) where the environment has a domain, otherwise the owner's address (personal).
 */
export function alertSender(target: DeployTarget): { address: string; identity: string } {
  if (target.dns !== undefined) {
    return {
      address: `${ALERT_SENDER_LOCAL_PART}@${target.dns.domain}`,
      identity: target.dns.domain,
    };
  }
  if (target.ownerEmail !== undefined) {
    return { address: target.ownerEmail, identity: target.ownerEmail };
  }
  throw new Error('alerts need a domain or an owner address to send from');
}

const BUNDLE_SCRIPT = fileURLToPath(
  new URL('../../../packages/alerts/src/bundle.ts', import.meta.url),
);
let bundleDir: string | undefined;

/**
 * The directory holding the alerts bundle (packages/alerts), built once per process. Its asset
 * hash is the bundle's content, so a template changes exactly when the deployed code does.
 */
function alertsBundle(): string {
  if (bundleDir === undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'listora-alerts-'));
    execFileSync(process.execPath, [BUNDLE_SCRIPT, dir], { stdio: 'inherit' });
    bundleDir = dir;
  }
  return bundleDir;
}

export interface AlertEmailsProps {
  readonly settings: EnvironmentSettings;
  readonly target: DeployTarget;
  /** Where the alert emails go. */
  readonly recipient: string;
  readonly alarmTopic: sns.Topic;
  readonly database: rds.DatabaseInstance;
}

/**
 * The operator's email (docs/features/alerts.md): a function that emails every message on the
 * alarm topic through SES, and a function that emails the weekly health summary every Monday at
 * 14:00 UTC (morning across US time zones). Both run outside the VPC and the application, so an
 * alert still goes out when the services or the database are down; they read nothing but
 * metrics, alarms, cost, and the database's backup status.
 */
export class AlertEmails extends Construct {
  readonly alertFunction: lambda.Function;
  readonly summaryFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: AlertEmailsProps) {
    super(scope, id);
    const { settings, target } = props;
    const prefix = `listora-${target.environment}`;
    const sender = alertSender(target);
    const code = lambda.Code.fromAsset(alertsBundle());
    const environment = {
      LISTORA_ENV: target.environment,
      ALERT_FROM: sender.address,
      ALERT_TO: props.recipient,
      DATABASE_INSTANCE_ID: props.database.instanceIdentifier,
      MARKETPLACES: Object.keys(settings.delistLatencyAlarmMinutes).join(','),
      MONTHLY_COST_THRESHOLD_USD: String(settings.monthlyCostAlarmUsd),
    };

    const fn = (
      name: string,
      handler: string,
      description: string,
      timeout: Duration,
    ): lambda.Function => {
      const functionName = `${prefix}-${name}`;
      const logGroup = new logs.LogGroup(this, `${name}-logs`, {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: settings.logRetention,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      return new lambda.Function(this, name, {
        functionName,
        description,
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        code,
        handler: `index.${handler}`,
        memorySize: 256,
        timeout,
        environment,
        logGroup,
      });
    };

    this.alertFunction = fn(
      'alert-email',
      'alert',
      'Emails every alarm and AWS event on the alarm topic to the operator (SES).',
      Duration.seconds(30),
    );
    props.alarmTopic.addSubscription(new subscriptions.LambdaSubscription(this.alertFunction));

    this.summaryFunction = fn(
      'weekly-summary',
      'weeklySummary',
      "Emails the operator the week's health: alarms, operations, worker, cost, and backups.",
      Duration.minutes(2),
    );
    new events.Rule(this, 'WeeklySummarySchedule', {
      ruleName: `${prefix}-weekly-summary`,
      description: 'Every Monday at 14:00 UTC: the weekly health summary email.',
      schedule: events.Schedule.cron({ weekDay: 'MON', hour: '14', minute: '0' }),
      targets: [new targets.LambdaFunction(this.summaryFunction, { retryAttempts: 2 })],
    });

    const { partition } = Stack.of(this);
    // In the SES sandbox, sending needs permission on the recipient's identity as well.
    const identity = (name: string): string =>
      `arn:${partition}:ses:${target.region}:${target.account}:identity/${name}`;
    const send = new iam.PolicyStatement({
      actions: ['ses:SendEmail'],
      resources: [...new Set([identity(sender.identity), identity(props.recipient)])],
      conditions: { StringEquals: { 'ses:FromAddress': sender.address } },
    });
    this.alertFunction.addToRolePolicy(send);
    this.summaryFunction.addToRolePolicy(send);

    this.summaryFunction.addToRolePolicy(
      new iam.PolicyStatement({
        // None of these can be limited to resources.
        actions: [
          'cloudwatch:DescribeAlarms',
          'cloudwatch:DescribeAlarmHistory',
          'cloudwatch:GetMetricData',
          'ce:GetCostAndUsage',
        ],
        resources: ['*'],
      }),
    );
    this.summaryFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['rds:DescribeDBInstances', 'rds:DescribeDBSnapshots'],
        resources: [
          props.database.instanceArn,
          `arn:${partition}:rds:${target.region}:${target.account}:snapshot:rds:${props.database.instanceIdentifier}-*`,
        ],
      }),
    );
  }
}

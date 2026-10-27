/**
 * The Lambda functions infra deploys from this package (bundled by `bundle.ts`): `alert`, which
 * the alarm topic invokes with every message, and `weeklySummary`, which an EventBridge schedule
 * invokes once a week. They run outside the application, so an alert still reaches the operator
 * when the API, the worker, or the database is down.
 */
import { alertEmail } from './alert-email.ts';
import { AwsHealthReader } from './aws-reader.ts';
import { collectHealth, type HealthReader } from './collect.ts';
import { SesMailer, type Mailer } from './mailer.ts';
import { weeklySummaryEmail } from './summary.ts';

/** One JSON line to the function's log (Lambda sends stdout to CloudWatch Logs). */
function log(fields: Record<string, string>): void {
  process.stdout.write(`${JSON.stringify(fields)}\n`);
}

/** The configuration infra sets on both functions (docs/features/alerts.md). */
export interface AlertsConfig {
  readonly environment: string;
  readonly region: string;
  readonly from: string;
  readonly to: string;
  readonly databaseInstanceId: string;
  readonly marketplaces: readonly string[];
  readonly monthlyCostThresholdUsd: number;
}

/** Parses the configuration; an error names the bad key, never its value. */
export function loadAlertsConfig(env: NodeJS.ProcessEnv): AlertsConfig {
  const required = (key: string): string => {
    const value = env[key];
    if (value === undefined || value === '') throw new Error(`${key} is required`);
    return value;
  };
  const threshold = Number(required('MONTHLY_COST_THRESHOLD_USD'));
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new Error('MONTHLY_COST_THRESHOLD_USD must be a positive number');
  }
  return {
    environment: required('LISTORA_ENV'),
    region: required('AWS_REGION'),
    from: required('ALERT_FROM'),
    to: required('ALERT_TO'),
    databaseInstanceId: required('DATABASE_INSTANCE_ID'),
    marketplaces: required('MARKETPLACES').split(','),
    monthlyCostThresholdUsd: threshold,
  };
}

/** The part of an SNS event the alert function reads. */
export interface SnsEvent {
  readonly Records: readonly {
    readonly Sns: {
      readonly Subject?: string | null;
      readonly Message: string;
      readonly Timestamp: string;
    };
  }[];
}

/**
 * Emails every message of the event. A failed send throws, so Lambda retries the delivery
 * (twice, for SNS's asynchronous invocation) instead of losing the alert.
 */
export async function sendAlerts(
  event: SnsEvent,
  config: AlertsConfig,
  mailer: Mailer,
): Promise<void> {
  for (const record of event.Records) {
    const email = alertEmail(
      {
        subject: record.Sns.Subject ?? undefined,
        message: record.Sns.Message,
        timestamp: record.Sns.Timestamp,
      },
      config,
    );
    await mailer.send(email);
    log({ event: 'alert_sent', subject: email.subject });
  }
}

/** Reads the past week and emails the summary. */
export async function sendWeeklySummary(
  config: AlertsConfig,
  reader: HealthReader,
  mailer: Mailer,
  now: Date,
): Promise<void> {
  const snapshot = await collectHealth(reader, config, now);
  const email = weeklySummaryEmail(snapshot, now);
  await mailer.send(email);
  log({ event: 'weekly_summary_sent', subject: email.subject });
}

function mailerFor(config: AlertsConfig): Mailer {
  return new SesMailer({ from: config.from, to: config.to });
}

export async function alert(event: SnsEvent): Promise<void> {
  const config = loadAlertsConfig(process.env);
  await sendAlerts(event, config, mailerFor(config));
}

export async function weeklySummary(): Promise<void> {
  const config = loadAlertsConfig(process.env);
  await sendWeeklySummary(config, new AwsHealthReader(), mailerFor(config), new Date());
}

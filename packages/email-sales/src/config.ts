/**
 * Email sale detection's settings (`EMAIL_*`, see `.env.example`), read once at startup by the
 * API (the forwarding address it shows, the dev drop endpoint) and the worker (the ingest
 * driver it reads mail with).
 */
import { fileURLToPath } from 'node:url';

/**
 * Where forwarded mail comes from: `folder` (development: `.eml` files dropped in a folder, or
 * posted to the API's `POST /dev/email`), `ses` (AWS: SES receiving stores each message in S3
 * and notifies a queue the worker reads), or `off` (no mail is read and no address is shown).
 */
export const EMAIL_INGEST_DRIVERS = ['folder', 'ses', 'off'] as const;
export type EmailIngestDriver = (typeof EMAIL_INGEST_DRIVERS)[number];

/** The folder driver's directory unless EMAIL_INBOX_DIR says otherwise: `.local/inbox`. */
export const DEFAULT_INBOX_DIR = fileURLToPath(new URL('../../../.local/inbox/', import.meta.url));

/** The forwarding addresses' domain in development, which nothing outside this Mac delivers to. */
export const DEFAULT_DEV_INBOUND_DOMAIN = 'in.listora.test';

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

export type EmailIngestConfig =
  | {
      driver: 'folder';
      /** The domain of every account's forwarding address (`sales+<token>@<domain>`). */
      inboundDomain: string;
      /** Where `.eml` files wait to be read; each is deleted once processed. */
      inboxDir: string;
    }
  | {
      driver: 'ses';
      inboundDomain: string;
      /** The SQS queue SES's notifications reach (through SNS). */
      queueUrl: string;
      /** The bucket SES stores raw messages in, and its region (the queue's too). */
      bucket: string;
      region: string;
    }
  | { driver: 'off' };

export class EmailIngestConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid email ingest configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'EmailIngestConfigError';
    this.issues = issues;
  }
}

/** Reads the EMAIL_* keys; error messages name a bad key but never echo its value. */
export function loadEmailIngestConfig(env: NodeJS.ProcessEnv = process.env): EmailIngestConfig {
  const value = (key: string): string | undefined => {
    const raw = env[key];
    return raw === undefined || raw === '' ? undefined : raw;
  };
  const raw = value('EMAIL_INGEST') ?? 'folder';
  const driver = EMAIL_INGEST_DRIVERS.find((candidate) => candidate === raw);
  if (driver === undefined) {
    throw new EmailIngestConfigError([
      `EMAIL_INGEST must be one of ${EMAIL_INGEST_DRIVERS.join(', ')}`,
    ]);
  }
  if (driver === 'off') return { driver };

  const issues: string[] = [];
  const domainValue = value('EMAIL_INBOUND_DOMAIN')?.toLowerCase();
  if (domainValue !== undefined && !DOMAIN.test(domainValue)) {
    issues.push('EMAIL_INBOUND_DOMAIN must be a DNS name such as in.example.com');
  }

  if (driver === 'folder') {
    const inboxDir = value('EMAIL_INBOX_DIR') ?? DEFAULT_INBOX_DIR;
    if (issues.length > 0) throw new EmailIngestConfigError(issues);
    return { driver, inboundDomain: domainValue ?? DEFAULT_DEV_INBOUND_DOMAIN, inboxDir };
  }

  if (domainValue === undefined)
    issues.push('EMAIL_INBOUND_DOMAIN is required when EMAIL_INGEST=ses');
  const queueUrl = value('EMAIL_SES_QUEUE_URL');
  if (queueUrl === undefined) {
    issues.push('EMAIL_SES_QUEUE_URL is required when EMAIL_INGEST=ses');
  } else if (
    !/^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com(\.cn)?\/\d{12}\/[\w-]{1,80}$/.test(queueUrl)
  ) {
    issues.push('EMAIL_SES_QUEUE_URL must be an SQS queue URL');
  }
  const bucket = value('EMAIL_SES_BUCKET');
  if (bucket === undefined) {
    issues.push('EMAIL_SES_BUCKET is required when EMAIL_INGEST=ses');
  } else if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    issues.push('EMAIL_SES_BUCKET must be an S3 bucket name');
  }
  const region = value('EMAIL_SES_REGION');
  if (region === undefined) {
    issues.push('EMAIL_SES_REGION is required when EMAIL_INGEST=ses');
  } else if (!REGION.test(region)) {
    issues.push('EMAIL_SES_REGION must be an AWS region such as us-east-1');
  }
  if (
    issues.length > 0 ||
    domainValue === undefined ||
    queueUrl === undefined ||
    bucket === undefined ||
    region === undefined
  ) {
    throw new EmailIngestConfigError(issues);
  }
  return { driver, inboundDomain: domainValue, queueUrl, bucket, region };
}

/** The forwarding addresses' domain, or undefined when this deployment reads no mail. */
export function inboundDomainOf(config: EmailIngestConfig): string | undefined {
  return config.driver === 'off' ? undefined : config.inboundDomain;
}

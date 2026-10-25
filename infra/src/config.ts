import { RetentionDays } from 'aws-cdk-lib/aws-logs';

import type { Marketplace } from '@listora/db';

/**
 * Deployment configuration. Two kinds of settings, kept apart on purpose:
 *
 * - `ENVIRONMENT_SETTINGS`: sizes, redundancy, and retention per environment. They are
 *   reviewed in code, so a change shows up in the snapshot diff.
 * - `DeployTarget`: where an environment lives (AWS account, region, DNS). Account ids and
 *   domains are never committed; they come from CDK context (`-c key=value`) or environment
 *   variables, and `loadDeployTarget` fails fast, naming the bad key but not its value.
 */

/**
 * `staging` and `prod` are the product's environments, each in its own AWS account.
 * `personal` is the smallest footprint that still runs every service around the clock, for
 * one reseller running Listora in their own AWS account (docs/features/costs.md prices it).
 */
export const ENVIRONMENT_NAMES = ['staging', 'prod', 'personal'] as const;
export type EnvironmentName = (typeof ENVIRONMENT_NAMES)[number];

export function isEnvironmentName(value: string): value is EnvironmentName {
  return ENVIRONMENT_NAMES.some((name) => name === value);
}

/** Fargate CPU units (1024 = 1 vCPU) and memory for one service. */
export interface ServiceSize {
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly minTasks: number;
  readonly maxTasks: number;
}

/**
 * How the API and the worker run on ECS:
 *
 * - `separate`: one Fargate service each, with its own size, scaling, and task role.
 * - `combined`: one Fargate service whose task runs both containers (the same image with the
 *   two commands), sharing one task size and one task role (the union of both grants). Half
 *   the tasks and public addresses; a crash of either container replaces the whole task.
 */
export type ServiceLayout =
  | { readonly layout: 'separate'; readonly api: ServiceSize; readonly worker: ServiceSize }
  | { readonly layout: 'combined'; readonly app: ServiceSize };

/**
 * How tasks reach the internet (marketplace, AI, and AWS APIs):
 *
 * - `nat`: tasks run in private `app` subnets behind NAT gateways. One gateway is the
 *   cheapest working setup; one per availability zone survives the loss of a zone.
 * - `public-ip`: tasks run in the public subnets with a public IPv4 address and no NAT. Their
 *   security groups admit nothing from the internet, so the address is only an egress path.
 */
export type TaskEgress =
  { readonly via: 'nat'; readonly natGateways: number } | { readonly via: 'public-ip' };

/**
 * How the public HTTPS endpoint of the API reaches the API tasks:
 *
 * - `load-balancer`: an internet-facing Application Load Balancer at `api.<domain>` that
 *   health-checks the tasks (`/health/live`) and redirects HTTP to HTTPS. Needs a domain.
 * - `http-api`: an API Gateway HTTP API with a VPC link to the tasks, found through Cloud Map,
 *   at its default `execute-api` URL and, with a domain, at `api.<domain>` too. No hourly
 *   charge, but requests are limited to 30 seconds and 10 MB (photo uploads go to S3
 *   directly), and ECS health-checks the API container itself. `disableDefaultEndpoint`
 *   turns the `execute-api` URL off, leaving only `api.<domain>`, so it needs a domain. It is
 *   separate from adding the domain: marketplaces and payment providers call back URLs
 *   registered at the `execute-api` URL until they are re-registered at `api.<domain>`
 *   (infra/README.md, Adding a domain later).
 */
export type ApiIngress =
  | { readonly via: 'load-balancer' }
  | { readonly via: 'http-api'; readonly disableDefaultEndpoint: boolean };

export interface EnvironmentSettings {
  /**
   * Guards against losing data: RDS deletion protection, CloudFormation termination
   * protection, ALB deletion protection, and retained secrets and log groups on stack
   * deletion. Buckets, the KMS key, and the image repository are always retained.
   */
  readonly protectData: boolean;
  readonly network: {
    /** VPC address range; distinct per environment so the networks can be peered later. */
    readonly cidr: string;
    readonly taskEgress: TaskEgress;
    /** Rejected-traffic VPC flow logs (CloudWatch Logs ingestion is billed per GB). */
    readonly rejectedFlowLogs: boolean;
  };
  readonly ingress: ApiIngress;
  readonly database: {
    /** RDS instance class, for example `t4g.micro` (Graviton burstable). */
    readonly instanceType: string;
    readonly multiAz: boolean;
    readonly allocatedStorageGiB: number;
    /** Storage autoscaling ceiling. */
    readonly maxAllocatedStorageGiB: number;
    readonly backupRetentionDays: number;
    readonly performanceInsights: boolean;
  };
  readonly services: ServiceLayout;
  /**
   * Reserved size of the on-demand headless-Chromium runner, a later task, that automates
   * Poshmark, Mercari, and Depop (decision D1 in docs/features/automation.md): started per batch of
   * listing actions and per scheduled sale check, zero tasks while idle. Nothing is
   * provisioned from it yet; it fixes the size that docs/features/costs.md prices, and the runner task
   * builds on it.
   */
  readonly browserRunner: ServiceSize;
  /** CloudWatch Logs retention for service, database, and VPC logs. */
  readonly logRetention: RetentionDays;
  /**
   * ECS Container Insights: per-service task counts (and more) at a CloudWatch charge. With
   * it, the running-tasks alarms compare running with desired tasks; without it, they count
   * the tasks that report CPU against the service's minimum.
   */
  readonly containerInsights: boolean;
  /**
   * The `ai-daily-cost` alarm fires when one account's AI cost today (UTC) reaches this many
   * US dollars: before the default daily circuit breaker (`AI_DAILY_BUDGET_USD`, $1) refuses
   * that account's next call.
   */
  readonly aiDailyCostAlarmUsd: number;
  /**
   * The `delist-latency-<marketplace>` alarms fire when the p95 delist latency on the
   * marketplace over an hour (from the sale being recorded to the verified delist of the
   * item's listing there) exceeds this many minutes: the item may stay for sale after selling.
   */
  readonly delistLatencyAlarmMinutes: Readonly<Record<Marketplace, number>>;
}

/** Most of the default $1 daily AI budget per account (packages/ai). */
const AI_DAILY_COST_ALARM_USD = 0.8;

/**
 * eBay delists through its API within minutes of a sale. The browser runner delists Depop
 * (until its partner API is granted), Poshmark, and Mercari, and their scheduled sale checks
 * run about every 12 hours, so a delist there can take that long.
 */
const DELIST_LATENCY_ALARM_MINUTES: Readonly<Record<Marketplace, number>> = {
  ebay: 10,
  depop: 13 * 60,
  poshmark: 13 * 60,
  mercari: 13 * 60,
};

/** Headless Chromium wants about a gigabyte per busy page; four leave room for a few. */
const BROWSER_RUNNER: ServiceSize = { cpu: 1024, memoryMiB: 4096, minTasks: 0, maxTasks: 1 };

export const ENVIRONMENT_SETTINGS: Readonly<Record<EnvironmentName, EnvironmentSettings>> = {
  staging: {
    protectData: false,
    network: {
      cidr: '10.10.0.0/16',
      taskEgress: { via: 'nat', natGateways: 1 },
      rejectedFlowLogs: true,
    },
    ingress: { via: 'load-balancer' },
    database: {
      instanceType: 't4g.micro',
      multiAz: false,
      allocatedStorageGiB: 20,
      maxAllocatedStorageGiB: 50,
      backupRetentionDays: 7,
      performanceInsights: false,
    },
    services: {
      layout: 'separate',
      api: { cpu: 256, memoryMiB: 512, minTasks: 1, maxTasks: 2 },
      worker: { cpu: 256, memoryMiB: 512, minTasks: 1, maxTasks: 2 },
    },
    browserRunner: BROWSER_RUNNER,
    logRetention: RetentionDays.ONE_MONTH,
    containerInsights: false,
    aiDailyCostAlarmUsd: AI_DAILY_COST_ALARM_USD,
    delistLatencyAlarmMinutes: DELIST_LATENCY_ALARM_MINUTES,
  },
  prod: {
    protectData: true,
    network: {
      cidr: '10.20.0.0/16',
      taskEgress: { via: 'nat', natGateways: 2 },
      rejectedFlowLogs: true,
    },
    ingress: { via: 'load-balancer' },
    database: {
      instanceType: 't4g.medium',
      multiAz: true,
      allocatedStorageGiB: 50,
      maxAllocatedStorageGiB: 500,
      backupRetentionDays: 30,
      performanceInsights: true,
    },
    services: {
      layout: 'separate',
      api: { cpu: 512, memoryMiB: 1024, minTasks: 2, maxTasks: 6 },
      worker: { cpu: 512, memoryMiB: 1024, minTasks: 2, maxTasks: 4 },
    },
    browserRunner: BROWSER_RUNNER,
    logRetention: RetentionDays.THREE_MONTHS,
    containerInsights: true,
    aiDailyCostAlarmUsd: AI_DAILY_COST_ALARM_USD,
    delistLatencyAlarmMinutes: DELIST_LATENCY_ALARM_MINUTES,
  },
  // One reseller, around 500 items, light traffic, every service running 24/7, at the lowest
  // monthly cost (docs/features/costs.md has the estimate and the alternatives it beat). The data is
  // real, so it is protected like prod's; everything else is the minimum that works.
  personal: {
    protectData: true,
    network: {
      cidr: '10.30.0.0/16',
      // No NAT gateway (about $33 a month before data); interface endpoints would cost more
      // and still leave the marketplace and AI APIs unreachable.
      taskEgress: { via: 'public-ip' },
      // Public subnets draw constant scanner traffic; logging every rejected packet would
      // cost more than the rest of the network.
      rejectedFlowLogs: false,
    },
    // An ALB costs about $24 a month with its two public addresses; the HTTP API costs cents.
    // The execute-api URL stays on until every URL registered with a third party has moved
    // to api.<domain>.
    ingress: { via: 'http-api', disableDefaultEndpoint: false },
    database: {
      // Single-AZ Graviton RDS beats Aurora Serverless v2: the worker keeps connections open,
      // so Aurora never pauses and bills at least 0.5 ACU around the clock.
      instanceType: 't4g.micro',
      multiAz: false,
      allocatedStorageGiB: 20,
      maxAllocatedStorageGiB: 50,
      // Backup storage up to the database's size is free.
      backupRetentionDays: 7,
      performanceInsights: false,
    },
    // One task runs both processes: 0.25 vCPU is the smallest Fargate size, and 1 GiB leaves
    // the worker room to decode full-size photos.
    services: { layout: 'combined', app: { cpu: 256, memoryMiB: 1024, minTasks: 1, maxTasks: 1 } },
    browserRunner: BROWSER_RUNNER,
    logRetention: RetentionDays.ONE_WEEK,
    containerInsights: false,
    aiDailyCostAlarmUsd: AI_DAILY_COST_ALARM_USD,
    delistLatencyAlarmMinutes: DELIST_LATENCY_ALARM_MINUTES,
  },
};

export const SERVICE_NAMES = ['api', 'worker'] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

/** An application secret: stored in Secrets Manager, injected into containers as `envVar`. */
export interface AppSecret {
  /** The secret is named `listora/<environment>/<name>`. */
  readonly name: string;
  readonly envVar: string;
  readonly description: string;
  /** Services whose containers receive the secret; nothing else can read it. */
  readonly services: readonly ServiceName[];
}

/**
 * Secrets the operator sets by hand (`aws secretsmanager put-secret-value`). CDK creates each
 * one with a random placeholder value, so a deploy never needs the real value. The database
 * password is not listed: RDS generates and stores it (`listora/<environment>/database`).
 */
export const APP_SECRETS: readonly AppSecret[] = [
  {
    name: 'anthropic-api-key',
    envVar: 'ANTHROPIC_API_KEY',
    description: 'Anthropic API key, read only when AI_PROVIDER=anthropic (packages/ai).',
    services: ['api', 'worker'],
  },
];

export function secretName(environment: EnvironmentName, name: string): string {
  return `listora/${environment}/${name}`;
}

/** Where one environment is deployed. Nothing here is committed to the repository. */
export interface DeployTarget {
  readonly environment: EnvironmentName;
  /** 12-digit AWS account id; each environment has its own account. */
  readonly account: string;
  readonly region: string;
  /**
   * The environment's domain. Required where the API is behind a load balancer (staging and
   * prod) or only at `api.<domain>` (`disableDefaultEndpoint`), optional behind the HTTP API
   * otherwise (personal): without one, the API answers at its default `execute-api` URL and
   * no sale email is received (infra/README.md).
   */
  readonly dns: DnsTarget | undefined;
  /** Tag of the application image in the environment's ECR repository (the git commit). */
  readonly imageTag: string;
  /** GitHub `owner/name` allowed to deploy through OIDC. */
  readonly githubRepository: string;
  /** Optional address subscribed to the alarm topic. */
  readonly alarmEmail: string | undefined;
  /**
   * The two availability zones the VPC spans, when they must be chosen: some services skip
   * a zone (in us-east-1, API Gateway VPC links and Graviton instances are not offered in
   * `use1-az3`), and zone names map to different zone ids in every account. Unset means the
   * region's first two zones, resolved at deploy time.
   */
  readonly availabilityZones: readonly string[] | undefined;
}

/** A domain and its hosted zone, always set together. */
export interface DnsTarget {
  /**
   * The environment's DNS name, for example `staging.listora.app`. The API is served at
   * `api.<domain>` and sale emails are received at `in.<domain>`.
   */
  readonly domain: string;
  /** Route 53 public hosted zone for `domain`, created when the domain is set up. */
  readonly hostedZoneId: string;
}

export class DeployConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid deploy configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'DeployConfigError';
    this.issues = issues;
  }
}

/** One setting: its CDK context key and the environment variable that can supply it. */
interface Source {
  readonly context: string;
  readonly env: string;
}

const SOURCES = {
  environment: { context: 'env', env: 'LISTORA_ENV' },
  account: { context: 'account', env: 'LISTORA_AWS_ACCOUNT_ID' },
  region: { context: 'region', env: 'LISTORA_AWS_REGION' },
  domain: { context: 'domain', env: 'LISTORA_DOMAIN' },
  hostedZoneId: { context: 'hostedZoneId', env: 'LISTORA_HOSTED_ZONE_ID' },
  imageTag: { context: 'imageTag', env: 'LISTORA_IMAGE_TAG' },
  githubRepository: { context: 'githubRepository', env: 'LISTORA_GITHUB_REPOSITORY' },
  alarmEmail: { context: 'alarmEmail', env: 'LISTORA_ALARM_EMAIL' },
  availabilityZones: { context: 'availabilityZones', env: 'LISTORA_AVAILABILITY_ZONES' },
} as const satisfies Record<Exclude<keyof DeployTarget, 'dns'> | keyof DnsTarget, Source>;

/** SES receives email only in some regions; us-east-1 also hosts CloudFront certificates. */
export const DEFAULT_REGION = 'us-east-1';
/** The repository whose workflows may deploy (a fork overrides it). */
export const DEFAULT_GITHUB_REPOSITORY = 'toniojbusiness/listora';

const ACCOUNT = /^\d{12}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const DOMAIN = /^(?=.{1,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const HOSTED_ZONE_ID = /^Z[A-Z0-9]{1,31}$/;
// ECR tag rules (letters, digits, `_`, `.`, `-`; up to 128), minus `latest`, which is mutable.
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Every environment spans two availability zones. */
export const AVAILABILITY_ZONE_COUNT = 2;

/** `staging, prod, or personal`, for messages. */
const ENVIRONMENT_CHOICES = `${ENVIRONMENT_NAMES.slice(0, -1).join(', ')}, or ${String(ENVIRONMENT_NAMES.at(-1))}`;

/** Reads one CDK context value (`node.tryGetContext`) or `undefined`. */
export type ContextReader = (key: string) => unknown;

/**
 * Resolves the deploy target from CDK context, then environment variables. Context wins so a
 * one-off `-c` flag can override an exported variable. Empty strings count as unset.
 */
export function loadDeployTarget(
  context: ContextReader,
  env: NodeJS.ProcessEnv = process.env,
  settings: Readonly<Record<EnvironmentName, EnvironmentSettings>> = ENVIRONMENT_SETTINGS,
): DeployTarget {
  const issues: string[] = [];

  const read = (source: Source): string | undefined => {
    const fromContext = context(source.context);
    if (fromContext !== undefined && fromContext !== null && fromContext !== '') {
      return typeof fromContext === 'string' ? fromContext : JSON.stringify(fromContext);
    }
    const fromEnv = env[source.env];
    return fromEnv === undefined || fromEnv === '' ? undefined : fromEnv;
  };

  const describe = (source: Source): string =>
    `${source.context} (context) or ${source.env} (environment)`;

  const required = (source: Source, pattern: RegExp, rule: string): string => {
    const value = read(source);
    if (value === undefined) {
      issues.push(`${describe(source)} is required`);
      return '';
    }
    if (!pattern.test(value)) issues.push(`${describe(source)} must be ${rule}`);
    return value;
  };

  const environmentValue = read(SOURCES.environment);
  let environment: EnvironmentName = 'staging';
  if (environmentValue === undefined) {
    issues.push(`${describe(SOURCES.environment)} is required (${ENVIRONMENT_CHOICES})`);
  } else if (isEnvironmentName(environmentValue)) {
    environment = environmentValue;
  } else {
    issues.push(`${describe(SOURCES.environment)} must be ${ENVIRONMENT_CHOICES}`);
  }

  const account = required(SOURCES.account, ACCOUNT, 'a 12-digit AWS account id');
  const region = read(SOURCES.region) ?? DEFAULT_REGION;
  if (!REGION.test(region)) issues.push(`${describe(SOURCES.region)} must be an AWS region`);
  // A load balancer serves only https://api.<domain>; the HTTP API also has its own URL unless
  // it is disabled. A domain and its hosted zone are set together or, where optional, not at
  // all.
  const { ingress } = settings[environment];
  const domainOptional = ingress.via === 'http-api' && !ingress.disableDefaultEndpoint;
  const dnsSet = read(SOURCES.domain) !== undefined || read(SOURCES.hostedZoneId) !== undefined;
  const dns: DnsTarget | undefined =
    domainOptional && !dnsSet
      ? undefined
      : {
          domain: required(SOURCES.domain, DOMAIN, 'a lowercase DNS name such as example.com'),
          hostedZoneId: required(
            SOURCES.hostedZoneId,
            HOSTED_ZONE_ID,
            'a Route 53 hosted zone id (Z...)',
          ),
        };
  const imageTag = required(SOURCES.imageTag, IMAGE_TAG, 'a valid container image tag');
  if (imageTag === 'latest') {
    issues.push(`${describe(SOURCES.imageTag)} must name an immutable tag, not latest`);
  }
  const githubRepository = read(SOURCES.githubRepository) ?? DEFAULT_GITHUB_REPOSITORY;
  if (!GITHUB_REPOSITORY.test(githubRepository)) {
    issues.push(`${describe(SOURCES.githubRepository)} must be a GitHub owner/name`);
  }
  const alarmEmail = read(SOURCES.alarmEmail);
  if (alarmEmail !== undefined && !EMAIL.test(alarmEmail)) {
    issues.push(`${describe(SOURCES.alarmEmail)} must be an email address`);
  }

  const zonesValue = read(SOURCES.availabilityZones);
  const availabilityZones = zonesValue?.split(',').map((zone) => zone.trim());
  if (
    availabilityZones !== undefined &&
    (availabilityZones.length !== AVAILABILITY_ZONE_COUNT ||
      new Set(availabilityZones).size !== availabilityZones.length ||
      !availabilityZones.every((zone) => new RegExp(`^${region}[a-z]$`).test(zone)))
  ) {
    issues.push(
      `${describe(SOURCES.availabilityZones)} must be ${String(AVAILABILITY_ZONE_COUNT)} distinct ` +
        'zones of the region, comma-separated (for example us-east-1a,us-east-1b)',
    );
  }

  if (issues.length > 0) throw new DeployConfigError(issues);
  return {
    environment,
    account,
    region,
    dns,
    imageTag,
    githubRepository,
    alarmEmail,
    availabilityZones,
  };
}

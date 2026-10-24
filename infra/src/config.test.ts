import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { describe, expect, it } from 'vitest';

import {
  APP_SECRETS,
  DEFAULT_GITHUB_REPOSITORY,
  DEFAULT_REGION,
  DeployConfigError,
  ENVIRONMENT_NAMES,
  ENVIRONMENT_SETTINGS,
  loadDeployTarget,
  type ServiceSize,
} from './config.ts';

const VALID = {
  env: 'staging',
  account: '123456789012',
  region: 'us-east-1',
  domain: 'staging.example.com',
  hostedZoneId: 'Z0123456789ABCDEFGHIJ',
  imageTag: '3f1c2a9',
  githubRepository: 'acme/listora',
};

/** `VALID` with no domain and no hosted zone. */
const NO_DOMAIN = { ...VALID, domain: undefined, hostedZoneId: undefined };

const fromRecord =
  (record: Record<string, unknown>) =>
  (key: string): unknown =>
    record[key];

function issuesOf(context: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): string[] {
  try {
    loadDeployTarget(fromRecord(context), env);
  } catch (error) {
    if (error instanceof DeployConfigError) return [...error.issues];
    throw error;
  }
  throw new Error('expected a DeployConfigError');
}

describe('loadDeployTarget', () => {
  it('reads every setting from CDK context', () => {
    expect(loadDeployTarget(fromRecord(VALID), {})).toEqual({
      environment: 'staging',
      account: '123456789012',
      region: 'us-east-1',
      dns: { domain: 'staging.example.com', hostedZoneId: 'Z0123456789ABCDEFGHIJ' },
      imageTag: '3f1c2a9',
      githubRepository: 'acme/listora',
      alarmEmail: undefined,
      availabilityZones: undefined,
    });
  });

  it('falls back to environment variables, and context wins over them', () => {
    const env = {
      LISTORA_ENV: 'prod',
      LISTORA_AWS_ACCOUNT_ID: '210987654321',
      LISTORA_AWS_REGION: 'us-west-2',
      LISTORA_DOMAIN: 'example.com',
      LISTORA_HOSTED_ZONE_ID: 'Z9',
      LISTORA_IMAGE_TAG: 'abc',
      LISTORA_GITHUB_REPOSITORY: 'acme/listora',
      LISTORA_ALARM_EMAIL: 'ops@example.com',
    };
    expect(loadDeployTarget(fromRecord({}), env)).toMatchObject({
      environment: 'prod',
      account: '210987654321',
      region: 'us-west-2',
      alarmEmail: 'ops@example.com',
    });
    expect(loadDeployTarget(fromRecord({ account: '111122223333' }), env).account).toBe(
      '111122223333',
    );
  });

  it('defaults the region and the deploying repository', () => {
    const context = { ...VALID, region: undefined, githubRepository: undefined };
    expect(loadDeployTarget(fromRecord(context), {})).toMatchObject({
      region: DEFAULT_REGION,
      githubRepository: DEFAULT_GITHUB_REPOSITORY,
    });
  });

  it('treats empty values as unset', () => {
    expect(issuesOf({ ...VALID, account: '' }, { LISTORA_AWS_ACCOUNT_ID: '' })).toEqual([
      'account (context) or LISTORA_AWS_ACCOUNT_ID (environment) is required',
    ]);
  });

  it('names every missing key at once', () => {
    expect(issuesOf({})).toEqual([
      'env (context) or LISTORA_ENV (environment) is required (staging, prod, or personal)',
      'account (context) or LISTORA_AWS_ACCOUNT_ID (environment) is required',
      'domain (context) or LISTORA_DOMAIN (environment) is required',
      'hostedZoneId (context) or LISTORA_HOSTED_ZONE_ID (environment) is required',
      'imageTag (context) or LISTORA_IMAGE_TAG (environment) is required',
    ]);
  });

  it('rejects malformed values without echoing them', () => {
    const bad = {
      env: 'production',
      account: '1234-5678-9012',
      region: 'mars',
      domain: 'Not A Domain',
      hostedZoneId: 'not-a-zone',
      imageTag: 'has spaces',
      githubRepository: 'no-slash',
      alarmEmail: 'nobody',
      availabilityZones: 'zone-a',
    };
    const issues = issuesOf(bad);
    expect(issues).toEqual([
      'env (context) or LISTORA_ENV (environment) must be staging, prod, or personal',
      'account (context) or LISTORA_AWS_ACCOUNT_ID (environment) must be a 12-digit AWS account id',
      'region (context) or LISTORA_AWS_REGION (environment) must be an AWS region',
      'domain (context) or LISTORA_DOMAIN (environment) must be a lowercase DNS name such as example.com',
      'hostedZoneId (context) or LISTORA_HOSTED_ZONE_ID (environment) must be a Route 53 hosted zone id (Z...)',
      'imageTag (context) or LISTORA_IMAGE_TAG (environment) must be a valid container image tag',
      'githubRepository (context) or LISTORA_GITHUB_REPOSITORY (environment) must be a GitHub owner/name',
      'alarmEmail (context) or LISTORA_ALARM_EMAIL (environment) must be an email address',
      'availabilityZones (context) or LISTORA_AVAILABILITY_ZONES (environment) must be 2 distinct zones of the region, comma-separated (for example us-east-1a,us-east-1b)',
    ]);
    for (const value of Object.values(bad)) {
      expect(issues.join('\n')).not.toContain(value);
    }
  });

  it('takes two chosen availability zones of the region, from context or the environment', () => {
    expect(
      loadDeployTarget(fromRecord({ ...VALID, availabilityZones: 'us-east-1b, us-east-1d' }), {})
        .availabilityZones,
    ).toEqual(['us-east-1b', 'us-east-1d']);
    expect(
      loadDeployTarget(fromRecord(VALID), { LISTORA_AVAILABILITY_ZONES: 'us-east-1a,us-east-1c' })
        .availabilityZones,
    ).toEqual(['us-east-1a', 'us-east-1c']);
    const issue =
      'availabilityZones (context) or LISTORA_AVAILABILITY_ZONES (environment) must be 2 ' +
      'distinct zones of the region, comma-separated (for example us-east-1a,us-east-1b)';
    for (const zones of [
      'us-east-1a',
      'us-east-1a,us-east-1b,us-east-1c',
      'us-east-1a,us-east-1a',
      'us-west-2a,us-west-2b',
      'us-east-1a,us-east-1-bos-1a',
    ]) {
      expect(issuesOf({ ...VALID, availabilityZones: zones }), zones).toEqual([issue]);
    }
  });

  it('lets personal deploy without a domain, since its HTTP API has its own URL', () => {
    expect(loadDeployTarget(fromRecord({ ...NO_DOMAIN, env: 'personal' }), {}).dns).toBeUndefined();
    expect(
      loadDeployTarget(fromRecord({ ...VALID, env: 'personal' }), {
        LISTORA_DOMAIN: '',
        LISTORA_HOSTED_ZONE_ID: '',
      }).dns,
    ).toEqual({ domain: 'staging.example.com', hostedZoneId: 'Z0123456789ABCDEFGHIJ' });
    // The deploy workflow passes unset GitHub variables as empty strings.
    expect(
      loadDeployTarget(fromRecord({ ...NO_DOMAIN, env: 'personal' }), {
        LISTORA_DOMAIN: '',
        LISTORA_HOSTED_ZONE_ID: '',
      }).dns,
    ).toBeUndefined();
  });

  it('requires a domain once the HTTP API serves only api.<domain>', () => {
    const settings = {
      ...ENVIRONMENT_SETTINGS,
      personal: {
        ...ENVIRONMENT_SETTINGS.personal,
        ingress: { via: 'http-api', disableDefaultEndpoint: true },
      },
    } as const;
    const load = (context: Record<string, unknown>) =>
      loadDeployTarget(fromRecord({ ...context, env: 'personal' }), {}, settings);
    expect(() => load(NO_DOMAIN)).toThrow(
      new DeployConfigError([
        'domain (context) or LISTORA_DOMAIN (environment) is required',
        'hostedZoneId (context) or LISTORA_HOSTED_ZONE_ID (environment) is required',
      ]),
    );
    expect(load(VALID).dns).toEqual({
      domain: 'staging.example.com',
      hostedZoneId: 'Z0123456789ABCDEFGHIJ',
    });
  });

  it('requires a domain behind a load balancer, which serves only api.<domain>', () => {
    for (const env of ['staging', 'prod']) {
      expect(issuesOf({ ...NO_DOMAIN, env }), env).toEqual([
        'domain (context) or LISTORA_DOMAIN (environment) is required',
        'hostedZoneId (context) or LISTORA_HOSTED_ZONE_ID (environment) is required',
      ]);
    }
  });

  it('takes a domain and its hosted zone together, never one alone', () => {
    for (const env of ['staging', 'personal']) {
      expect(issuesOf({ ...NO_DOMAIN, env, domain: 'example.com' }), env).toEqual([
        'hostedZoneId (context) or LISTORA_HOSTED_ZONE_ID (environment) is required',
      ]);
      expect(issuesOf({ ...NO_DOMAIN, env }, { LISTORA_HOSTED_ZONE_ID: 'Z9' }), env).toEqual([
        'domain (context) or LISTORA_DOMAIN (environment) is required',
      ]);
    }
    expect(issuesOf({ ...NO_DOMAIN, env: 'personal', domain: 'Not A Domain' })).toEqual([
      'domain (context) or LISTORA_DOMAIN (environment) must be a lowercase DNS name such as example.com',
      'hostedZoneId (context) or LISTORA_HOSTED_ZONE_ID (environment) is required',
    ]);
  });

  it('refuses the mutable latest tag, so a deploy always names the image it runs', () => {
    expect(issuesOf({ ...VALID, imageTag: 'latest' })).toEqual([
      'imageTag (context) or LISTORA_IMAGE_TAG (environment) must name an immutable tag, not latest',
    ]);
  });
});

describe('ENVIRONMENT_SETTINGS', () => {
  it('protects prod data and runs prod redundantly; staging is the cheap single-zone copy', () => {
    const { staging, prod } = ENVIRONMENT_SETTINGS;
    expect(prod.protectData).toBe(true);
    expect(prod.database.multiAz).toBe(true);
    expect(prod.network.taskEgress).toEqual({ via: 'nat', natGateways: 2 });
    expect(
      prod.services.layout === 'separate' && prod.services.api.minTasks,
    ).toBeGreaterThanOrEqual(2);
    expect(staging.protectData).toBe(false);
    expect(staging.database.multiAz).toBe(false);
    expect(staging.network.taskEgress).toEqual({ via: 'nat', natGateways: 1 });
    for (const settings of [staging, prod]) {
      expect(settings.ingress).toEqual({ via: 'load-balancer' });
      expect(settings.services.layout).toBe('separate');
      expect(settings.network.rejectedFlowLogs).toBe(true);
    }
  });

  it('runs personal at the smallest 24/7 footprint, with its real data protected', () => {
    const { personal } = ENVIRONMENT_SETTINGS;
    expect(personal.protectData).toBe(true);
    // No NAT gateway and no load balancer: their hourly charges dwarf everything else.
    expect(personal.network.taskEgress).toEqual({ via: 'public-ip' });
    expect(personal.network.rejectedFlowLogs).toBe(false);
    // The execute-api URL stays on, so adding a domain breaks no registered callback URL.
    expect(personal.ingress).toEqual({ via: 'http-api', disableDefaultEndpoint: false });
    // The smallest Graviton class, one zone, autoscaled storage, automated backups.
    expect(personal.database).toMatchObject({
      instanceType: 't4g.micro',
      multiAz: false,
      allocatedStorageGiB: 20,
      performanceInsights: false,
    });
    expect(personal.database.maxAllocatedStorageGiB).toBeGreaterThan(20);
    expect(personal.database.backupRetentionDays).toBeGreaterThanOrEqual(1);
    // One always-on task of the smallest Fargate CPU runs the API and the worker together.
    expect(personal.services).toEqual({
      layout: 'combined',
      app: { cpu: 256, memoryMiB: 1024, minTasks: 1, maxTasks: 1 },
    });
    expect(personal.logRetention).toBe(RetentionDays.ONE_WEEK);
    expect(personal.containerInsights).toBe(false);
  });

  it('keeps every service size a valid Fargate combination with a sane scaling range', () => {
    const memoryByCpu: Record<number, [number, number]> = {
      256: [512, 2048],
      512: [1024, 4096],
      1024: [2048, 8192],
      2048: [4096, 16384],
    };
    const check = (size: ServiceSize, minTasks: number, label: string) => {
      const range = memoryByCpu[size.cpu];
      expect(range, `${label} cpu ${String(size.cpu)}`).toBeDefined();
      if (range === undefined) return;
      expect(size.memoryMiB, label).toBeGreaterThanOrEqual(range[0]);
      expect(size.memoryMiB, label).toBeLessThanOrEqual(range[1]);
      expect(size.minTasks, label).toBeGreaterThanOrEqual(minTasks);
      expect(size.maxTasks, label).toBeGreaterThanOrEqual(Math.max(size.minTasks, 1));
    };
    for (const name of ENVIRONMENT_NAMES) {
      const { services, browserRunner } = ENVIRONMENT_SETTINGS[name];
      const sizes =
        services.layout === 'separate' ? [services.api, services.worker] : [services.app];
      for (const size of sizes) check(size, 1, name);
      // The browser runner is started per job: nothing runs, and nothing is billed, while idle.
      check(browserRunner, 0, `${name} browser runner`);
      expect(browserRunner.minTasks).toBe(0);
      expect(browserRunner.memoryMiB).toBeGreaterThanOrEqual(2048);
    }
  });
});

describe('docs/costs.md', () => {
  const costs = readFileSync(new URL('../../docs/costs.md', import.meta.url), 'utf8');

  it('prices the personal settings as they are', () => {
    const { personal } = ENVIRONMENT_SETTINGS;
    const app = personal.services.layout === 'combined' ? personal.services.app : undefined;
    expect(app).toBeDefined();
    expect(costs).toContain(`\`db.${personal.database.instanceType}\``);
    expect(costs).toContain(`${String(personal.database.allocatedStorageGiB)} GB gp3`);
    expect(costs).toContain(`${String(personal.database.backupRetentionDays)} days`);
    expect(costs).toContain(
      `${String((app?.cpu ?? 0) / 1024)} vCPU at $0.04048 and ${String((app?.memoryMiB ?? 0) / 1024)} GB`,
    );
    const runner = personal.browserRunner;
    expect(costs).toContain(
      `${String(runner.cpu / 1024)} vCPU and ${String(runner.memoryMiB / 1024)} GB, with no task while idle`,
    );
  });

  /** The text of one `## ` section, up to the next one. */
  const section = (heading: string): string => {
    const start = costs.indexOf(`\n## ${heading}\n`);
    expect(start, heading).toBeGreaterThanOrEqual(0);
    const end = costs.indexOf('\n## ', start + 1);
    return costs.slice(start, end === -1 ? undefined : end);
  };
  /** Amounts in cents: plain line items, and bold rows (subtotals and totals) by label. */
  const amounts = (text: string) => ({
    items: [...text.matchAll(/^\|.*\|\s+\$(\d+\.\d{2}) \|$/gm)].map((match) =>
      Math.round(Number(match[1]) * 100),
    ),
    bold: new Map(
      [...text.matchAll(/^\| \*\*(.+?)\*\* .*\*\*\$(\d+\.\d{2})\*\* \|$/gm)].map((match) => [
        match[1],
        Math.round(Number(match[2]) * 100),
      ]),
    ),
  });
  const sum = (cents: readonly number[]) => cents.reduce((total, value) => total + value, 0);
  const dollars = (cents: number | undefined) => String(Math.round((cents ?? NaN) / 100));

  it('has line items that add up to its totals, with and without browser automation and a domain', () => {
    const base = amounts(section('Line items'));
    const baseTotal = base.bold.get('Total');
    expect(base.items.length).toBeGreaterThan(10);
    expect(sum(base.items)).toBe(baseTotal);

    const automation = amounts(section('Browser automation'));
    const subtotal = automation.bold.get('Automation subtotal');
    expect(automation.items.length).toBeGreaterThanOrEqual(5);
    expect(sum(automation.items)).toBe(subtotal);
    const withAutomation = automation.bold.get('Total with browser automation');
    expect(withAutomation).toBe((baseTotal ?? NaN) + (subtotal ?? NaN));

    // The headline figures, here and in infra/README.md, are the rounded totals.
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const headline = `about $${dollars(baseTotal)} a month, or about $${dollars(withAutomation)} a month with browser automation`;
    expect(costs.replace(/\s+/g, ' ')).toContain(headline);
    expect(readme.replace(/\s+/g, ' ')).toContain(headline);

    // A domain (added later) prices on top of the base, with or without automation.
    const domain = amounts(section('With a domain'));
    const domainCents = sum(domain.items);
    expect(domain.items.length).toBe(2);
    expect(domain.bold.get('Total with a domain')).toBe((baseTotal ?? NaN) + domainCents);
    const cents = (value: number) => `$${(value / 100).toFixed(2)}`;
    expect(costs.replace(/\s+/g, ' ')).toContain(
      `the total is ${cents((withAutomation ?? NaN) + domainCents)}`,
    );
    for (const text of [costs, readme]) {
      expect(text.replace(/\s+/g, ' ')).toContain(`${cents(domainCents)} more once a domain`);
    }
  });
});

describe('APP_SECRETS', () => {
  it('maps each secret to an environment variable documented in .env.example', () => {
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    for (const secret of APP_SECRETS) {
      expect(example).toMatch(new RegExp(`^#? ?${secret.envVar}=`, 'm'));
      expect(secret.services.length).toBeGreaterThan(0);
    }
  });
});

describe('infra sources', () => {
  it('never hardcode an AWS account id', () => {
    const srcDir = fileURLToPath(new URL('.', import.meta.url));
    const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' }).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'placeholders.ts',
    );
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      expect(readFileSync(join(srcDir, file), 'utf8'), file).not.toMatch(/\b\d{12}\b/);
    }
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  APP_SECRETS,
  DEFAULT_GITHUB_REPOSITORY,
  DEFAULT_REGION,
  DeployConfigError,
  ENVIRONMENT_NAMES,
  ENVIRONMENT_SETTINGS,
  loadDeployTarget,
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
      domain: 'staging.example.com',
      hostedZoneId: 'Z0123456789ABCDEFGHIJ',
      imageTag: '3f1c2a9',
      githubRepository: 'acme/listora',
      alarmEmail: undefined,
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
      'env (context) or LISTORA_ENV (environment) is required (staging or prod)',
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
    };
    const issues = issuesOf(bad);
    expect(issues).toEqual([
      'env (context) or LISTORA_ENV (environment) must be staging or prod',
      'account (context) or LISTORA_AWS_ACCOUNT_ID (environment) must be a 12-digit AWS account id',
      'region (context) or LISTORA_AWS_REGION (environment) must be an AWS region',
      'domain (context) or LISTORA_DOMAIN (environment) must be a lowercase DNS name such as example.com',
      'hostedZoneId (context) or LISTORA_HOSTED_ZONE_ID (environment) must be a Route 53 hosted zone id (Z...)',
      'imageTag (context) or LISTORA_IMAGE_TAG (environment) must be a valid container image tag',
      'githubRepository (context) or LISTORA_GITHUB_REPOSITORY (environment) must be a GitHub owner/name',
      'alarmEmail (context) or LISTORA_ALARM_EMAIL (environment) must be an email address',
    ]);
    for (const value of Object.values(bad)) {
      expect(issues.join('\n')).not.toContain(value);
    }
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
    expect(prod.network.natGateways).toBe(2);
    expect(prod.api.minTasks).toBeGreaterThanOrEqual(2);
    expect(staging.protectData).toBe(false);
    expect(staging.database.multiAz).toBe(false);
    expect(staging.network.natGateways).toBe(1);
  });

  it('keeps every service size a valid Fargate combination with a sane scaling range', () => {
    const memoryByCpu: Record<number, [number, number]> = {
      256: [512, 2048],
      512: [1024, 4096],
      1024: [2048, 8192],
      2048: [4096, 16384],
    };
    for (const name of ENVIRONMENT_NAMES) {
      for (const size of [ENVIRONMENT_SETTINGS[name].api, ENVIRONMENT_SETTINGS[name].worker]) {
        const range = memoryByCpu[size.cpu];
        expect(range, `cpu ${String(size.cpu)}`).toBeDefined();
        if (range === undefined) continue;
        expect(size.memoryMiB).toBeGreaterThanOrEqual(range[0]);
        expect(size.memoryMiB).toBeLessThanOrEqual(range[1]);
        expect(size.minTasks).toBeGreaterThanOrEqual(1);
        expect(size.maxTasks).toBeGreaterThanOrEqual(size.minTasks);
      }
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

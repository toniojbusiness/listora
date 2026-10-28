import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { assertNever } from '@listora/shared';

import { LocalDiskStorage } from './local.ts';
import { createS3Client, S3Storage } from './s3.ts';
import { STORAGE_DRIVERS, type ObjectStorage } from './storage.ts';

/** `.local/storage` at the repository root (gitignored). */
export const DEFAULT_LOCAL_STORAGE_DIR = fileURLToPath(
  new URL('../../../.local/storage/', import.meta.url),
);
export const DEFAULT_LOCAL_STORAGE_BASE_URL = 'http://127.0.0.1:3000';
export const MIN_LOCAL_SIGNING_SECRET_LENGTH = 32;

export type StorageConfig =
  | {
      readonly driver: 'local';
      readonly rootDir: string;
      readonly baseUrl: string;
      /** Absent means a random key per process (upload URLs end when the API restarts). */
      readonly signingSecret: string | undefined;
    }
  | {
      readonly driver: 's3';
      readonly bucket: string;
      readonly region: string;
      readonly endpoint: string | undefined;
      readonly publicBaseUrl: string;
      /** The CloudFront distribution at `publicBaseUrl`; only the worker invalidates it. */
      readonly cdnDistributionId: string | undefined;
    };

export class StorageConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid storage configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'StorageConfigError';
    this.issues = issues;
  }
}

/**
 * Reads the storage settings from the environment (see `.env.example`), once at startup.
 * Errors name the bad key but never echo its value.
 */
export function loadStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const issues: string[] = [];
  const driver = env['STORAGE_DRIVER'] ?? 'local';
  const known = STORAGE_DRIVERS.find((name) => name === driver);
  if (known === undefined) {
    throw new StorageConfigError([`STORAGE_DRIVER must be one of ${STORAGE_DRIVERS.join(', ')}`]);
  }

  switch (known) {
    case 'local': {
      const rootDir = env['STORAGE_LOCAL_DIR'] ?? DEFAULT_LOCAL_STORAGE_DIR;
      if (rootDir === '') issues.push('STORAGE_LOCAL_DIR must not be empty');
      const baseUrl = env['STORAGE_LOCAL_BASE_URL'] ?? DEFAULT_LOCAL_STORAGE_BASE_URL;
      if (!isHttpUrl(baseUrl)) issues.push('STORAGE_LOCAL_BASE_URL must be an http(s) URL');
      const signingSecret = env['STORAGE_LOCAL_SIGNING_SECRET'];
      if (signingSecret !== undefined && signingSecret.length < MIN_LOCAL_SIGNING_SECRET_LENGTH) {
        issues.push(
          `STORAGE_LOCAL_SIGNING_SECRET must be at least ${String(MIN_LOCAL_SIGNING_SECRET_LENGTH)} characters`,
        );
      }
      if (issues.length > 0) throw new StorageConfigError(issues);
      return { driver: known, rootDir, baseUrl, signingSecret };
    }
    case 's3': {
      const bucket = env['STORAGE_S3_BUCKET'] ?? '';
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
        issues.push('STORAGE_S3_BUCKET must be an S3 bucket name');
      }
      const region = env['STORAGE_S3_REGION'] ?? '';
      if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) {
        issues.push('STORAGE_S3_REGION must be an AWS region such as us-east-1');
      }
      const endpoint = env['STORAGE_S3_ENDPOINT'];
      if (endpoint !== undefined && !isHttpUrl(endpoint)) {
        issues.push('STORAGE_S3_ENDPOINT must be an http(s) URL');
      }
      const publicBaseUrl = env['STORAGE_PUBLIC_BASE_URL'] ?? '';
      if (!isHttpUrl(publicBaseUrl)) {
        issues.push('STORAGE_PUBLIC_BASE_URL must be an http(s) URL when STORAGE_DRIVER is s3');
      }
      const cdnDistributionId = env['STORAGE_CDN_DISTRIBUTION_ID'];
      if (cdnDistributionId !== undefined && !/^[A-Z0-9]{8,32}$/.test(cdnDistributionId)) {
        issues.push('STORAGE_CDN_DISTRIBUTION_ID must be a CloudFront distribution id');
      }
      if (issues.length > 0) throw new StorageConfigError(issues);
      return { driver: known, bucket, region, endpoint, publicBaseUrl, cdnDistributionId };
    }
    default:
      return assertNever(known);
  }
}

export function createStorage(config: StorageConfig): ObjectStorage {
  switch (config.driver) {
    case 'local':
      return new LocalDiskStorage({
        rootDir: config.rootDir,
        baseUrl: config.baseUrl,
        signingSecret: config.signingSecret ?? randomBytes(32).toString('base64url'),
      });
    case 's3':
      return new S3Storage({
        client: createS3Client({
          region: config.region,
          ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
        }),
        bucket: config.bucket,
        publicBaseUrl: config.publicBaseUrl,
        ...(config.cdnDistributionId === undefined
          ? {}
          : {
              cdn: {
                // CloudFront's API is global, served from us-east-1.
                client: new CloudFrontClient({ region: 'us-east-1' }),
                distributionId: config.cdnDistributionId,
              },
            }),
      });
    default:
      return assertNever(config);
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

import { describe, expect, it } from 'vitest';

import {
  createStorage,
  DEFAULT_LOCAL_STORAGE_BASE_URL,
  DEFAULT_LOCAL_STORAGE_DIR,
  loadStorageConfig,
  StorageConfigError,
} from './config.ts';
import { LocalDiskStorage } from './local.ts';
import { S3Storage } from './s3.ts';

function issuesOf(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadStorageConfig(env);
  } catch (error) {
    if (error instanceof StorageConfigError) return error.issues;
    throw error;
  }
  return [];
}

describe('loadStorageConfig', () => {
  it('defaults to the local driver under .local/storage', () => {
    const config = loadStorageConfig({});
    expect(config).toEqual({
      driver: 'local',
      rootDir: DEFAULT_LOCAL_STORAGE_DIR,
      baseUrl: DEFAULT_LOCAL_STORAGE_BASE_URL,
      signingSecret: undefined,
    });
    expect(DEFAULT_LOCAL_STORAGE_DIR).toMatch(/\/\.local\/storage\/$/);
    expect(createStorage(config)).toBeInstanceOf(LocalDiskStorage);
  });

  it('reads the S3 settings and needs every required one', () => {
    const config = loadStorageConfig({
      STORAGE_DRIVER: 's3',
      STORAGE_S3_BUCKET: 'listora-prod-photos',
      STORAGE_S3_REGION: 'us-east-1',
      STORAGE_PUBLIC_BASE_URL: 'https://images.listora.app',
    });
    expect(config).toEqual({
      driver: 's3',
      bucket: 'listora-prod-photos',
      region: 'us-east-1',
      endpoint: undefined,
      publicBaseUrl: 'https://images.listora.app',
    });
    // Building the client needs no credentials; they are resolved on the first request.
    expect(createStorage(config)).toBeInstanceOf(S3Storage);

    expect(issuesOf({ STORAGE_DRIVER: 's3' })).toEqual([
      'STORAGE_S3_BUCKET must be an S3 bucket name',
      'STORAGE_S3_REGION must be an AWS region such as us-east-1',
      'STORAGE_PUBLIC_BASE_URL must be an http(s) URL when STORAGE_DRIVER is s3',
    ]);
  });

  it('names bad keys without echoing their values', () => {
    const secret = 'too-short-secret';
    const issues = issuesOf({
      STORAGE_LOCAL_SIGNING_SECRET: secret,
      STORAGE_LOCAL_BASE_URL: 'ftp://nope',
    });
    expect(issues).toEqual([
      'STORAGE_LOCAL_BASE_URL must be an http(s) URL',
      'STORAGE_LOCAL_SIGNING_SECRET must be at least 32 characters',
    ]);
    expect(issues.join('\n')).not.toContain(secret);
    expect(issuesOf({ STORAGE_DRIVER: 'gcs' })).toEqual([
      'STORAGE_DRIVER must be one of local, s3',
    ]);
  });
});

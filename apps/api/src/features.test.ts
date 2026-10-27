import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONTRACT_METHODS, loadContractDocument } from '@listora/api-contract';
import { createDatabase } from '@listora/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { buildApp, type AppDependencies } from './app.ts';
import { API_FEATURES, discoverApiFeatures } from './features.ts';
import { offlineDependencies } from './test-support.ts';

const scratchDirs: string[] = [];

async function srcDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'listora-api-features-'));
  scratchDirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

afterEach(async () => {
  for (const dir of scratchDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('API feature discovery', () => {
  it('finds every feature folder of src/', () => {
    expect(API_FEATURES.map(({ name }) => name)).toEqual([
      'account',
      'activity',
      'analyses',
      'batches',
      'connections',
      'invites',
      'items',
      'listings',
      'marketplace-sessions',
      'operations',
      'phone',
      'photos',
      'prefill',
      'pricing',
      'profile',
      'profit',
      'sale-emails',
      'sales',
      'tasks',
      'today',
      'uploads',
      'usage',
      'voice',
      'webhooks',
    ]);
  });

  it('imports feature.ts files in folder name order and skips folders without one', async () => {
    const feature = 'export const feature = { registerRoutes: () => {} };\n';
    const dir = await srcDir({
      'zebra/feature.ts': feature,
      'apple/feature.ts': feature,
      'helpers/util.ts': 'export const x = 1;\n',
    });
    expect((await discoverApiFeatures(dir)).map(({ name }) => name)).toEqual(['apple', 'zebra']);
  });

  it('refuses a feature.ts without an ApiFeature export', async () => {
    const dir = await srcDir({ 'broken/feature.ts': 'export const routes = () => {};\n' });
    await expect(discoverApiFeatures(dir)).rejects.toThrow(
      /broken\/feature\.ts must export `feature`, an ApiFeature with registerRoutes/,
    );
  });
});

describe('buildApp', () => {
  // Never connected: registering routes reads no data.
  const db = createDatabase({ connectionString: 'postgres://listora@127.0.0.1:1/unused' });
  const auth: AppDependencies['auth'] = {
    provider: 'dev',
    verifyAccessToken: () => Promise.resolve(undefined),
  };

  afterAll(async () => {
    await db.destroy();
  });

  it.each([
    ['account', 'deleteAccount'],
    ['analyses', 'startItemAnalysis'],
    ['connections', 'listConnections'],
    ['items', 'createItem'],
    ['listings', 'linkItemListing'],
    ['listings', 'publishListing'],
    ['operations', 'retryOperation'],
    ['photos', 'addItemPhoto'],
    ['pricing', 'getItemPricing'],
    ['uploads', 'createUploadSession'],
    ['usage', 'getUsage'],
  ])('serves the %s feature (%s)', async (_feature, operationId) => {
    const app = buildApp({
      db,
      auth,
      ...offlineDependencies(),
      pingDatabase: () => Promise.reject(new Error('must not be called')),
    });
    try {
      const { paths } = loadContractDocument();
      const route = Object.entries(paths).flatMap(([path, item]) =>
        CONTRACT_METHODS.filter((method) => item[method]?.operationId === operationId).map(
          (method) => ({ method: method.toUpperCase(), url: path.replaceAll(/\{(\w+)\}/g, ':$1') }),
        ),
      );
      expect(route).toHaveLength(1);
      await app.ready();
      expect(app.hasRoute(route[0] as { method: 'GET'; url: string })).toBe(true);
    } finally {
      await app.close();
    }
  });
});

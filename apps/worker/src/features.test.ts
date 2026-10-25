import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ACCOUNT_DELETION_TASK } from '@listora/accounts';
import { ITEM_ANALYSIS_TASK } from '@listora/analysis';
import { AUTO_DELIST_SLA_TASK } from '@listora/auto-delist';
import { SALE_ORDER_TASK } from '@listora/automation';
import { TRUST_METRICS_CRONTAB, TRUST_METRICS_TASK } from '@listora/observability';
import { LISTING_RESYNC_TASK } from '@listora/operations';
import { PHOTO_PROCESSING_TASK } from '@listora/photos';
import { PUSH_TASK } from '@listora/push';
import { SALE_FEES_TASK } from '@listora/sales';
import { createLogger } from '@listora/shared';
import { TODAY_SUMMARY_TASK } from '@listora/today';
import { afterEach, describe, expect, it } from 'vitest';

import {
  collectWorkerJobs,
  discoverWorkerFeatures,
  WORKER_FEATURES,
  type DiscoveredWorkerFeature,
  type WorkerContext,
} from './features.ts';
import { AI_SPEND_CHECK_TASK } from './features/ai-spend-check.ts';

const scratchDirs: string[] = [];

async function featuresDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'listora-worker-features-'));
  scratchDirs.push(dir);
  for (const [file, content] of Object.entries(files)) await writeFile(join(dir, file), content);
  return dir;
}

afterEach(async () => {
  for (const dir of scratchDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Features' `jobs` only build closures, so they never touch the context's services. */
const context = {
  config: {
    aiAlerts: {},
    analysis: { autoEscalate: false },
    marketplaces: { ebay: undefined },
    push: { driver: 'fake' },
  },
  connections: {
    tokens: undefined,
    ebaySeller: undefined,
    scheduledTasks: [],
    tasks: {},
    revoker: undefined,
  },
  logger: createLogger({ service: 'worker-test', level: 'silent' }),
} as unknown as WorkerContext;

const feature = (
  name: string,
  jobs: ReturnType<DiscoveredWorkerFeature['feature']['jobs']>,
): DiscoveredWorkerFeature => ({ name, feature: { jobs: () => jobs } });

describe('worker feature discovery', () => {
  it('finds every feature in features/', () => {
    expect(WORKER_FEATURES.map(({ name }) => name)).toEqual([
      'account-deletion',
      'ai-spend-check',
      'analysis',
      'auto-delist',
      'automation-sales',
      'connection-health',
      'ebay-sync',
      'photos',
      'push',
      'sale-fees',
      'today-summary',
      'trust-metrics',
    ]);
  });

  it('registers every feature job under its task name', () => {
    const { tasks, scheduledTasks, crontab } = collectWorkerJobs(WORKER_FEATURES, context);
    expect(Object.keys(tasks).sort()).toEqual(
      [
        ACCOUNT_DELETION_TASK,
        ITEM_ANALYSIS_TASK,
        LISTING_RESYNC_TASK,
        PHOTO_PROCESSING_TASK,
        PUSH_TASK,
        SALE_ORDER_TASK,
        SALE_FEES_TASK,
        TRUST_METRICS_TASK,
      ].sort(),
    );
    expect(scheduledTasks.map(({ name }) => name)).toEqual([
      AI_SPEND_CHECK_TASK,
      AUTO_DELIST_SLA_TASK,
      TODAY_SUMMARY_TASK,
    ]);
    expect(crontab).toEqual([TRUST_METRICS_CRONTAB]);
  });

  it('imports modules in file name order and skips tests', async () => {
    const module = 'export const feature = { jobs: () => ({}) };\n';
    const dir = await featuresDir({
      'zebra.ts': module,
      'apple.ts': module,
      'apple.test.ts': 'throw new Error("never imported");\n',
      'notes.md': '# not a module\n',
    });
    expect((await discoverWorkerFeatures(dir)).map(({ name }) => name)).toEqual(['apple', 'zebra']);
  });

  it('refuses a module without a WorkerFeature export', async () => {
    const dir = await featuresDir({ 'broken.ts': 'export const tasks = {};\n' });
    await expect(discoverWorkerFeatures(dir)).rejects.toThrow(
      /broken\.ts must export `feature`, a WorkerFeature with jobs/,
    );
  });

  it('refuses two features with one task name', () => {
    const run = () => Promise.resolve();
    expect(() =>
      collectWorkerJobs(
        [feature('a', { tasks: { shared: run } }), feature('b', { tasks: { shared: run } })],
        context,
      ),
    ).toThrow('Worker features a and b both define the task shared');
    expect(() =>
      collectWorkerJobs(
        [
          feature('a', { tasks: { shared: run } }),
          feature('b', { scheduledTasks: [{ name: 'shared', schedule: '* * * * *', run }] }),
        ],
        context,
      ),
    ).toThrow('Worker features a and b both define the task shared');
  });
});

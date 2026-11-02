import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addJob } from '@listora/db';

import { createEngineHarness, type EngineHarness } from './test-support.ts';
import type { OperationWorker } from './worker.ts';

/** The production poll (queuePollIntervalMs at scale 1): a missed new job waits this long. */
const POLL_MS = 5_000;
/** A new operation that waits longer than this was missed by its fetch and found by a poll. */
const STARTED_WITHIN_MS = 2_000;
/** As many other tasks as the worker's other-jobs runner has: Postgres orders its fetch by them. */
const OTHER_TASKS = Object.fromEntries(
  Array.from({ length: 30 }, (_, n) => [`other_${String(n)}`, () => Promise.resolve()]),
);

describe('the worker job fetch (real Postgres)', () => {
  let harness: EngineHarness;
  let worker: OperationWorker;

  beforeAll(async () => {
    harness = await createEngineHarness('jobfetch');
    // Both runners, as the worker runs them: operations, and other jobs with no listing queue.
    worker = await harness.startWorker({
      pollIntervalMs: POLL_MS,
      tasks: OTHER_TASKS,
    });
  });

  afterAll(async () => {
    await worker.stop();
    await harness.close();
  });

  // Each new job wakes both runners, and both fetch at once. A fetch of the other runner's must
  // never lock the listing queues away from the operations runner's (docs/features/performance.md).
  it('starts each new operation at once, even though the other runner fetches with it', async () => {
    // Prepared, the fetch is planned generically from its sixth run on each connection.
    for (let n = 0; n < 30; n += 1) {
      await addJob(harness.db, { task: 'other_0', payload: {}, jobKey: `other:${String(n)}` });
    }

    const late: string[] = [];
    for (let n = 0; n < 100; n += 1) {
      const listing = await harness.createListing();
      const op = await harness.enqueue(listing, 'create', {
        status: 'active',
        title: 'Fetch test jacket',
        priceCents: 2500,
      });
      const queuedAt = Date.now();
      await harness.waitForStatus(op.id, ['running', 'succeeded'], POLL_MS * 3);
      const waitedMs = Date.now() - queuedAt;
      if (waitedMs > STARTED_WITHIN_MS) late.push(`${op.id} waited ${String(waitedMs)} ms`);
      await harness.waitForStatus(op.id, ['succeeded']);
    }
    expect(late).toEqual([]);
    // A fetch whose text Graphile Worker changed would have stopped the worker (job-fetch.ts).
    expect(harness.fatalErrors).toEqual([]);
  }, 120_000);
});

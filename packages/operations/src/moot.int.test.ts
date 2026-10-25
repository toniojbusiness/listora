/**
 * `cancelMootOperations`, which the auto-delist orchestrator runs on each listing of an item
 * that sold: edits waiting to run or retry and publishes that never reached the marketplace
 * are canceled; a publish that may have reached it, and work waiting for the user, are kept.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cancelMootOperations } from './commands.ts';
import type { RetryPolicy } from './policy.ts';
import { createEngineHarness, type EngineHarness } from './test-support.ts';

/** Long enough that nothing retries while a test looks. */
const SLOW_RETRIES: RetryPolicy = {
  delaysMs: [60_000, 60_000, 60_000, 60_000, 60_000, 60_000],
  jitter: 0,
  random: () => 0.5,
};

describe('cancelMootOperations', () => {
  let harness: EngineHarness;

  beforeAll(async () => {
    harness = await createEngineHarness('moot');
  });

  afterAll(async () => {
    await harness.close();
    expect(harness.fatalErrors).toEqual([]);
  });

  it('cancels waiting edits and unsent publishes, and keeps what may be on the marketplace', async () => {
    const listing = await harness.createListing('ebay');
    // A create that reached the fake marketplace: its 5xx may hide an applied listing.
    harness.fake.inject({ action: 'create', sku: listing.id, fault: { type: 'server_error' } });
    const create = await harness.enqueue(listing, 'create', { title: 'Jacket', priceCents: 4500 });
    const worker = await harness.startWorker({ policy: SLOW_RETRIES });
    try {
      await harness.waitForStatus(create.id, ['retrying']);
    } finally {
      await worker.stop();
    }
    const price = await harness.enqueue(listing, 'price', { priceCents: 3900 });
    const revise = await harness.enqueue(listing, 'revise', { title: 'Jacket, worn twice' });

    const canceled = await cancelMootOperations(harness.db, {
      accountId: harness.accountId,
      listingId: listing.id,
      reason: 'the item sold',
      detail: { saleId: 'sale-1' },
    });
    expect(canceled).toEqual([price.id, revise.id]);
    expect((await harness.operation(create.id)).status).toBe('retrying');
    for (const op of [price, revise]) {
      expect(await harness.operation(op.id)).toMatchObject({ status: 'canceled' });
      expect((await harness.events(op.id)).at(-1)?.detail).toMatchObject({
        action: 'supersede',
        reason: 'the item sold',
        saleId: 'sale-1',
      });
    }

    // A publish that was never sent is moot too.
    const draft = await harness.createListing('ebay');
    const unsent = await harness.enqueue(draft, 'create', { title: 'Shirt', priceCents: 2000 });
    expect(
      await cancelMootOperations(harness.db, {
        accountId: harness.accountId,
        listingId: draft.id,
        reason: 'the item sold',
      }),
    ).toEqual([unsent.id]);
  });

  it('leaves work that waits for the user to the delist, which supersedes it', async () => {
    const listing = await harness.createListing('poshmark');
    const create = await harness.enqueue(listing, 'create', { title: 'Dress', priceCents: 3000 });
    const worker = await harness.startWorker();
    try {
      await harness.waitForStatus(create.id, ['needs_user_action']);
    } finally {
      await worker.stop();
    }
    expect(
      await cancelMootOperations(harness.db, {
        accountId: harness.accountId,
        listingId: listing.id,
        reason: 'the item sold',
      }),
    ).toEqual([]);
    expect((await harness.operation(create.id)).status).toBe('needs_user_action');
  });
});

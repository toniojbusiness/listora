/**
 * A price drop on the engine (docs/features/price-drops.md): an ordinary price change queued by
 * a rule (`reprice_rule`), confirmed only by a read-back of the new price, failed visibly with a
 * Retry when the marketplace refuses it, and recorded in the owner's log in Test mode.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { useMarketplaceFeatures } from '@listora/marketplaces';

import { InvalidOperationError } from './errors.ts';
import { FAST_POLICY, createEngineHarness, type EngineHarness } from './test-support.ts';

const SETTLED = ['succeeded', 'failed', 'canceled', 'needs_user_action'] as const;

describe('price drop operations (real Postgres, fake marketplace)', () => {
  let harness: EngineHarness;

  beforeAll(async () => {
    harness = await createEngineHarness('price_drop');
  });

  afterAll(async () => {
    await harness.close();
    expect(harness.fatalErrors).toEqual([]);
  });

  async function liveListing() {
    const listing = await harness.createListing('ebay');
    const create = await harness.enqueue(listing, 'create', {
      title: 'Fleece pullover',
      priceCents: 4000,
    });
    await harness.waitForStatus(create.id, SETTLED);
    return harness.listing(listing.id);
  }

  async function ruleFor(itemId: string) {
    const rule = await harness.db
      .insertInto('price_drop_rule')
      .values({
        account_id: harness.accountId,
        scope: 'item',
        item_id: itemId,
        percent: 10,
        after_days: 21,
        floor_cents: 2000,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return rule.id;
  }

  it('succeeds only once the read shows the new price, and names its rule', async () => {
    const worker = await harness.startWorker({ policy: FAST_POLICY });
    try {
      const listing = await liveListing();
      const ruleId = await ruleFor(listing.item_id);
      const drop = await harness.enqueue(
        listing,
        'price',
        { priceCents: 3600 },
        { origin: 'reprice_rule', priceDropRuleId: ruleId },
      );
      const done = await harness.waitForStatus(drop.id, SETTLED);
      expect(done).toMatchObject({
        status: 'succeeded',
        success_evidence: 'read_back',
        origin: 'reprice_rule',
        price_drop_rule_id: ruleId,
      });
      expect(harness.fake.listings('ebay', listing.id).map((remote) => remote.priceCents)).toEqual([
        3600,
      ]);
    } finally {
      await worker.stop();
    }
  });

  it('fails visibly, retryable, when the marketplace refuses the price', async () => {
    const worker = await harness.startWorker({ policy: FAST_POLICY });
    try {
      const listing = await liveListing();
      const ruleId = await ruleFor(listing.item_id);
      harness.fake.inject({
        action: 'update',
        sku: listing.id,
        fault: { type: 'reject', message: 'Price too low.' },
      });
      const drop = await harness.enqueue(
        listing,
        'price',
        { priceCents: 3600 },
        { origin: 'reprice_rule', priceDropRuleId: ruleId },
      );
      const done = await harness.waitForStatus(drop.id, SETTLED);
      expect(done.status).toBe('failed');
      expect(done.success_evidence).toBeNull();
      expect(done.error_message).toBeTruthy();
    } finally {
      await worker.stop();
    }
  });

  it('keeps the drop in the history when its rule is deleted', async () => {
    const listing = await harness.createListing('ebay');
    const ruleId = await ruleFor(listing.item_id);
    const drop = await harness.enqueue(
      listing,
      'price',
      { priceCents: 3600 },
      { origin: 'reprice_rule', priceDropRuleId: ruleId },
    );
    await harness.db.deleteFrom('price_drop_rule').where('id', '=', ruleId).execute();
    expect(await harness.operation(drop.id)).toMatchObject({
      origin: 'reprice_rule',
      price_drop_rule_id: null,
    });
  });

  it('refuses a price drop without its rule, a rule on another change, or another kind', async () => {
    const listing = await harness.createListing('ebay');
    const ruleId = await ruleFor(listing.item_id);
    await expect(
      harness.enqueue(listing, 'price', { priceCents: 3600 }, { origin: 'reprice_rule' }),
    ).rejects.toThrow(InvalidOperationError);
    await expect(
      harness.enqueue(listing, 'price', { priceCents: 3600 }, { priceDropRuleId: ruleId }),
    ).rejects.toThrow(InvalidOperationError);
    await expect(
      harness.enqueue(
        listing,
        'end',
        { status: 'ended' },
        { origin: 'reprice_rule', priceDropRuleId: ruleId },
      ),
    ).rejects.toThrow(InvalidOperationError);
  });

  it('records a price drop that ran in Test mode in the owner’s log (test-mode.md)', async () => {
    const worker = await harness.startWorker({ policy: FAST_POLICY });
    useMarketplaceFeatures('verified');
    try {
      const listing = await liveListing();
      const ruleId = await ruleFor(listing.item_id);
      await harness.db
        .updateTable('account')
        .set({ test_mode: true })
        .where('id', '=', harness.accountId)
        .execute();
      // The create and the seller's own price change are not price drops: they record nothing.
      const own = await harness.enqueue(listing, 'price', { priceCents: 3900 });
      await harness.waitForStatus(own.id, SETTLED);
      const drop = await harness.enqueue(
        listing,
        'price',
        { priceCents: 3500 },
        { origin: 'reprice_rule', priceDropRuleId: ruleId },
      );
      await harness.waitForStatus(drop.id, SETTLED);
      const runs = await harness.db
        .selectFrom('feature_test_run')
        .select(['marketplace', 'feature', 'outcome', 'subject_id'])
        .where('account_id', '=', harness.accountId)
        .execute();
      expect(runs).toEqual([
        { marketplace: 'ebay', feature: 'price_drops', outcome: 'passed', subject_id: drop.id },
      ]);
    } finally {
      useMarketplaceFeatures('all');
      await harness.db
        .updateTable('account')
        .set({ test_mode: false })
        .where('id', '=', harness.accountId)
        .execute();
      await worker.stop();
    }
  });
});

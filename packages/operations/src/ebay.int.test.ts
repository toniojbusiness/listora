/**
 * The operation engine with the real eBay adapter against the fake eBay: a listing's whole
 * life through the engine, and a chaos run with eBay's own failure modes (429s, 5xx before
 * and after the change, eBay system errors, expired tokens, timeouts after the change was
 * applied, and stale reads within eBay's consistency window). eBay's reads carry no freshness
 * marker, so every success rests on two matching reads a delay apart.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OperationKind } from '@listora/db';
import {
  createEbayAdapter,
  FakeEbay,
  loadEbayConfig,
  type AdapterLookup,
  type DesiredListingState,
  type FakeEbayFault,
} from '@listora/marketplaces';

import type { RetryPolicy } from './policy.ts';
import { OPERATION_TRANSITIONS } from './state-machine.ts';
import { createEngineHarness, type EngineHarness, type ListingRow } from './test-support.ts';
import type { OperationRow } from './transitions.ts';

/** eBay's reads catch up within this window in the fake; every retry delay is longer. */
const STALE_WINDOW_MS = 40;
const POLICY: RetryPolicy = {
  delaysMs: [80, 90, 100, 110, 120, 130],
  jitter: 0,
  random: () => 0.5,
};

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('the engine with the eBay adapter and the fake eBay', () => {
  let harness: EngineHarness;
  let fake: FakeEbay;
  let adapters: AdapterLookup;

  beforeAll(async () => {
    harness = await createEngineHarness('ebay');
    fake = await FakeEbay.start({ staleReadWindowMs: STALE_WINDOW_MS });
    const config = loadEbayConfig({ EBAY_ENV: 'fake', EBAY_FAKE_URL: fake.url });
    if (config === undefined) throw new Error('no eBay configuration');
    const ebay = createEbayAdapter(config, { requestTimeoutMs: 300 });
    adapters = (marketplace) => (marketplace === 'ebay' ? ebay : harness.adapters(marketplace));
    // Warm up the token, the first connection, and the JIT, so the short timeouts hold.
    await ebay.healthCheck({ signal: AbortSignal.timeout(10_000), connection: null });
  });

  afterAll(async () => {
    await harness.close();
    await fake.close();
  });

  it('lists, reprices, ends, and relists, each confirmed by eBay reads', async () => {
    const worker = await harness.startWorker({ adapters, policy: POLICY });
    try {
      const listing = await harness.createListing('ebay');
      const create = await harness.enqueue(listing, 'create', {
        title: 'eBay engine jacket',
        priceCents: 5500,
      });
      expect(await harness.waitForStatus(create.id, ['succeeded', 'failed'])).toMatchObject({
        status: 'succeeded',
        success_evidence: 'read_back',
      });
      const listed = await harness.listing(listing.id);
      const itemId = listed.external_listing_id ?? '';
      expect(fake.listing(itemId)).toMatchObject({
        title: 'eBay engine jacket',
        price: '55.0',
        status: 'Active',
      });
      expect(listed).toMatchObject({ status: 'active', remote_revision: null });
      expect(listed.external_url).toBe(`${fake.url}/itm/${itemId}`);

      const price = await harness.enqueue(listing, 'price', { priceCents: 4900, currency: 'USD' });
      const end = await harness.enqueue(listing, 'end', { status: 'ended' });
      const relist = await harness.enqueue(listing, 'relist', { status: 'active' });
      for (const op of [price, end, relist]) {
        expect(await harness.waitForStatus(op.id, ['succeeded', 'failed'])).toMatchObject({
          status: 'succeeded',
        });
      }
      const relisted = await harness.listing(listing.id);
      expect(relisted.external_listing_id).not.toBe(itemId);
      expect(fake.listing(itemId)).toMatchObject({
        status: 'Ended',
        relistedItemId: relisted.external_listing_id,
      });
      expect(fake.listing(relisted.external_listing_id ?? '')).toMatchObject({
        status: 'Active',
        price: '49.0',
      });
    } finally {
      await worker.stop();
    }
    expect(harness.fatalErrors).toEqual([]);
  });

  it.each([
    [7, 0.4],
    [19, 0.7],
  ])(
    'chaos seed %i, fault rate %f: no success without eBay showing it, no listing created twice',
    async (seed, rate) => {
      const listingIndex = new Map<string, number>();
      const requestCount = new Map<string, number>();
      fake.setChaos(({ action, sku }) => {
        const index = listingIndex.get(sku ?? '');
        if (index === undefined) return undefined;
        const count = requestCount.get(sku ?? '') ?? 0;
        requestCount.set(sku ?? '', count + 1);
        const rng = random(seed * 1_000_003 + index * 7_919 + count);
        if (action === 'get_item') {
          if (rng() >= rate) return undefined;
          return pick(rng, [
            [5, { type: 'stale_read' }],
            [2, { type: 'server_error' }],
            [1, { type: 'system_error' }],
          ]);
        }
        if (rng() >= rate) return undefined;
        return pick(rng, [
          [4, { type: 'rate_limited' }],
          [3, { type: 'server_error' }],
          [3, { type: 'server_error', status: 502, afterApply: true }],
          [2, { type: 'system_error', afterApply: true }],
          [2, { type: 'token_expired' }],
          [4, { type: 'timeout_after_send', delayMs: 800 }],
        ]);
      });
      const plan = random(seed);
      const worker = await harness.startWorker({ adapters, policy: POLICY, concurrency: 6 });
      const runs: { listing: ListingRow; operations: OperationRow[] }[] = [];
      try {
        for (let index = 0; index < 5; index += 1) {
          const listing = await harness.createListing('ebay');
          listingIndex.set(listing.id, index);
          const operations: OperationRow[] = [];
          for (const [kind, desired] of planOperations(plan)) {
            operations.push(await harness.enqueue(listing, kind, desired));
          }
          runs.push({ listing, operations });
        }
        for (const { operations } of runs) {
          for (const op of operations)
            await harness.waitForStatus(op.id, ['succeeded', 'failed'], 60_000);
        }
      } finally {
        fake.setChaos(undefined);
        await worker.stop();
      }
      expect(harness.fatalErrors).toEqual([]);

      let succeeded = 0;
      for (const { listing, operations } of runs) {
        const onEbay = fake.listings(listing.id);
        // One create at most, whatever was retried: every other listing with the SKU is a relist.
        const relists = operations.filter((op) => op.kind === 'relist').length;
        expect(onEbay.length).toBeLessThanOrEqual(1 + relists);
        expect(onEbay.filter((entry) => entry.status === 'Active').length).toBeLessThanOrEqual(1);

        for (const created of operations) {
          const op = await harness.operation(created.id);
          const events = await harness.events(op.id);
          for (const [index, event] of events.entries()) {
            if (index === 0 || event.from_status === null) continue;
            expect(event.from_status).toBe(events[index - 1]?.to_status);
            expect(OPERATION_TRANSITIONS[event.from_status]).toContain(event.to_status);
          }
          if (op.status === 'succeeded') {
            succeeded += 1;
            expect(op.success_evidence).toBe('read_back');
            const evidence = events.at(-1)?.detail as { remote?: Record<string, unknown> };
            expect(evidence.remote).toMatchObject(op.desired);
          } else {
            expect(op).toMatchObject({ status: 'failed', success_evidence: null });
            expect(op.error_message).toEqual(expect.any(String));
          }
        }

        // When the newest operation succeeded, eBay still shows its state on the live listing.
        const newest = await harness.operation(operations.at(-1)?.id ?? '');
        if (newest.status === 'succeeded') {
          const row = await harness.listing(listing.id);
          const live = fake.listing(row.external_listing_id ?? '');
          const desired = newest.desired as DesiredListingState;
          if (desired.status === 'ended') expect(live?.status).toBe('Ended');
          if (desired.status === 'active') expect(live?.status).toBe('Active');
          if (desired.priceCents !== undefined) {
            expect(Math.round(Number(live?.price) * 100)).toBe(desired.priceCents);
          }
          if (desired.title !== undefined) expect(live?.title).toBe(desired.title);
        }
      }
      const faults = fake.requests.filter(
        (request) => request.fault !== null && listingIndex.has(request.sku ?? ''),
      );
      expect(faults.length).toBeGreaterThan(5);
      expect(succeeded).toBeGreaterThan(0);
    },
    120_000,
  );
});

function pick(
  rng: () => number,
  choices: readonly (readonly [number, FakeEbayFault])[],
): FakeEbayFault {
  const total = choices.reduce((sum, [weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [weight, choice] of choices) {
    roll -= weight;
    if (roll < 0) return choice;
  }
  const last = choices.at(-1);
  if (last === undefined) throw new Error('no choices');
  return last[1];
}

/** Create, then up to three of price changes, revisions, ends, and relists. */
function planOperations(rng: () => number): [OperationKind, DesiredListingState][] {
  const plan: [OperationKind, DesiredListingState][] = [
    ['create', { status: 'active', title: 'Chaos eBay jacket', priceCents: 5000 }],
  ];
  let active = true;
  for (let index = 0; index < 1 + Math.floor(rng() * 3); index += 1) {
    if (!active) {
      plan.push(['relist', { status: 'active' }]);
      active = true;
      continue;
    }
    const roll = rng();
    if (roll < 0.4)
      plan.push(['price', { priceCents: 1000 + Math.floor(rng() * 9000), currency: 'USD' }]);
    else if (roll < 0.7) plan.push(['revise', { title: `Chaos eBay jacket ${String(index)}` }]);
    else {
      plan.push(['end', { status: 'ended' }]);
      active = false;
    }
  }
  return plan;
}

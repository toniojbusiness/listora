/**
 * The operation engine with the real Depop adapter against the fake Depop. Depop listings are
 * named by Listora's SKUs, so the engine names each new listing before it sends anything: a
 * create whose answer is lost is found by that SKU, a relist goes under the next one, and a
 * refused create leaves no listing behind. DELETE answers 200 even for a missing product, and
 * Depop's reads carry no freshness marker, so every success rests on two matching GET
 * read-backs a delay apart. A chaos run checks that nothing succeeds without Depop showing it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OperationKind } from '@listora/db';
import {
  createDepopAdapter,
  FakeDepop,
  loadDepopConfig,
  type AdapterLookup,
  type DesiredListingState,
  type FakeDepopFault,
  type ListingContent,
} from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import { retryOperation } from './commands.ts';
import type { RetryPolicy } from './policy.ts';
import { OPERATION_TRANSITIONS } from './state-machine.ts';
import { createEngineHarness, type EngineHarness, type ListingRow } from './test-support.ts';
import type { OperationRow } from './transitions.ts';

const POLICY: RetryPolicy = {
  delaysMs: [60, 70, 80, 90, 100, 110],
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

describe('the engine with the Depop adapter and the fake Depop', () => {
  let harness: EngineHarness;
  let fake: FakeDepop;
  let adapters: AdapterLookup;
  /** The Depop connection the fake's development seller is bound to (DEPOP_USER_CONNECTION_ID). */
  let connectionId: string;

  beforeAll(async () => {
    harness = await createEngineHarness('depop');
    fake = await FakeDepop.start();
    const connection = await harness.db
      .insertInto('marketplace_connection')
      .values({
        account_id: harness.accountId,
        marketplace: 'depop',
        mode: 'api',
        external_user_id: String(fake.developmentSellerId),
      })
      .returning(['id', 'mode'])
      .executeTakeFirstOrThrow();
    connectionId = connection.id;
    const config = loadDepopConfig({
      DEPOP_ENV: 'fake',
      DEPOP_FAKE_URL: fake.url,
      DEPOP_USER_CONNECTION_ID: connectionId,
    });
    if (config === undefined) throw new Error('no Depop configuration');
    const depop = createDepopAdapter(config, { requestTimeoutMs: 400, refusalGraceMs: 30 });
    adapters = (marketplace) => (marketplace === 'depop' ? depop : harness.adapters(marketplace));
    // Warm up the token, the first connection, and the JIT, so the short timeouts hold.
    await depop.healthCheck({ signal: AbortSignal.timeout(10_000), connection });
  });

  afterAll(async () => {
    await harness.close();
    expect(fake.specViolations).toEqual([]);
    await fake.close();
  });

  /** A Depop listing on the bound connection, and listing content with its item's SKU. */
  async function createDepopListing(): Promise<{ listing: ListingRow; content: ListingContent }> {
    const created = await harness.createListing('depop');
    const listing = await harness.db
      .updateTable('marketplace_listing')
      .set({ connection_id: connectionId })
      .where('id', '=', created.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const { sku } = await harness.db
      .selectFrom('inventory_item')
      .select('sku')
      .where('id', '=', listing.item_id)
      .executeTakeFirstOrThrow();
    const content = sampleListingContent({
      item: { itemId: listing.item_id, sku, category: 'clothing/tops/t_shirts' },
      variant: { hashtags: ['vintage'] },
    });
    return { listing, content };
  }

  const done = (op: OperationRow, timeoutMs?: number) =>
    harness.waitForStatus(op.id, ['succeeded', 'failed'], timeoutMs);

  it('lists, reprices, ends, relists under a new SKU, and marks sold, each confirmed by Depop reads', async () => {
    const worker = await harness.startWorker({ adapters, policy: POLICY });
    try {
      const { listing, content } = await createDepopListing();
      const sku = content.item.sku;
      const create = await harness.enqueue(listing, 'create', {}, { content });
      expect(await done(create)).toMatchObject({
        status: 'succeeded',
        success_evidence: 'read_back',
      });
      const listed = await harness.listing(listing.id);
      expect(listed).toMatchObject({
        status: 'active',
        external_listing_id: `${sku}-D1`,
        pending_external_listing_id: null,
        remote_revision: null,
      });
      const product = fake.product(`${sku}-D1`);
      expect(listed.external_url).toBe(`https://www.depop.com/products/${product?.slug ?? ''}/`);
      // Depop has no title; the description carries the hashtag line.
      expect(product?.fields['description']).toBe(`${content.variant.description}\n\n#vintage`);
      // The id was named, and recorded, before the create was sent.
      const named = (await harness.events(create.id)).find(
        (event) => event.to_status === 'running',
      );
      expect(named?.detail).toMatchObject({ namedListingId: `${sku}-D1` });

      const price = await harness.enqueue(listing, 'price', { priceCents: 3900, currency: 'USD' });
      const end = await harness.enqueue(listing, 'end', { status: 'ended' });
      const relist = await harness.enqueue(listing, 'relist', {}, { content });
      for (const op of [price, end, relist]) {
        expect(await done(op)).toMatchObject({ status: 'succeeded' });
      }
      const relisted = await harness.listing(listing.id);
      expect(relisted).toMatchObject({ external_listing_id: `${sku}-D2`, status: 'active' });
      expect(fake.product(`${sku}-D1`)?.status).toBe('STATUS_DELETED_ONSALE');
      expect(fake.product(`${sku}-D2`)).toMatchObject({
        status: 'STATUS_ONSALE',
        fields: { price_amount: '45.00' },
      });

      // A sale elsewhere: Depop marks it sold.
      const sold = await harness.enqueue(listing, 'mark_sold', { status: 'sold' });
      expect(await done(sold)).toMatchObject({ status: 'succeeded' });
      expect(fake.product(`${sku}-D2`)?.status).toBe('STATUS_MARKED_AS_SOLD');
      expect(await harness.listing(listing.id)).toMatchObject({ status: 'sold' });
    } finally {
      await worker.stop();
    }
    expect(harness.fatalErrors).toEqual([]);
  });

  it('finds a create whose answer was lost by the SKU it named, and makes one product', async () => {
    const worker = await harness.startWorker({ adapters, policy: POLICY });
    try {
      const { listing, content } = await createDepopListing();
      const sku = `${content.item.sku}-D1`;
      fake.inject({ action: 'put', sku, fault: { type: 'timeout_after_send', delayMs: 1_500 } });
      const create = await harness.enqueue(listing, 'create', {}, { content });
      expect(await done(create)).toMatchObject({
        status: 'succeeded',
        success_evidence: 'read_back',
      });
      expect(fake.products(sku)).toHaveLength(1);
      expect((await harness.listing(listing.id)).external_listing_id).toBe(sku);
    } finally {
      await worker.stop();
    }
  });

  it("never takes DELETE's 200 for a product Depop doesn't have as a delist", async () => {
    const worker = await harness.startWorker({ adapters, policy: POLICY });
    try {
      const { listing } = await createDepopListing();
      await harness.db
        .updateTable('marketplace_listing')
        .set({ external_listing_id: 'ZZ-000001-D1', status: 'active' })
        .where('id', '=', listing.id)
        .execute();
      const end = await harness.enqueue(listing, 'end', { status: 'ended' });
      const finished = await done(end, 20_000);
      expect(finished).toMatchObject({ status: 'failed', success_evidence: null });
      expect(finished.error_message).toContain('Depop');
      const deletes = fake.requests.filter(
        (request) => request.action === 'delete' && request.sku === 'ZZ-000001-D1',
      );
      expect(deletes.length).toBeGreaterThan(0);
      expect(deletes.every((request) => request.status === 200)).toBe(true);
    } finally {
      await worker.stop();
    }
  });

  it('forgets the SKU of a create Depop refused, and its Retry sends the same SKU', async () => {
    const worker = await harness.startWorker({ adapters, policy: POLICY });
    try {
      const { listing, content } = await createDepopListing();
      const sku = `${content.item.sku}-D1`;
      fake.inject({
        action: 'put',
        sku,
        fault: { type: 'reject', code: 'invalid_brand', message: 'Unknown brand' },
      });
      const create = await harness.enqueue(listing, 'create', {}, { content });
      expect(await done(create)).toMatchObject({ status: 'failed' });
      // Nothing was made, so nothing is pending for a delist to wait on.
      expect(await harness.listing(listing.id)).toMatchObject({
        external_listing_id: null,
        pending_external_listing_id: null,
      });
      await retryOperation(harness.db, { accountId: harness.accountId, operationId: create.id });
      expect(await done(create)).toMatchObject({ status: 'succeeded' });
      expect((await harness.listing(listing.id)).external_listing_id).toBe(sku);
      expect(fake.products(`${content.item.sku}-D2`)).toEqual([]);
    } finally {
      await worker.stop();
    }
  });

  it('chaos: no success without Depop showing it, and never two live products for a listing', async () => {
    const seed = 11;
    const rate = 0.45;
    const listingSkus = new Set<string>();
    const requestCount = new Map<string, number>();
    fake.setChaos(({ action, sku }) => {
      if (sku === null || ![...listingSkus].some((base) => sku.startsWith(base))) return undefined;
      const count = requestCount.get(sku) ?? 0;
      requestCount.set(sku, count + 1);
      const rng = random(seed * 1_000_003 + checksum(sku) * 7_919 + count);
      if (rng() >= rate) return undefined;
      if (action === 'get') {
        return pick(rng, [
          [4, { type: 'stale_read' }],
          [2, { type: 'not_visible' }],
          [2, { type: 'server_error' }],
        ]);
      }
      return pick(rng, [
        [4, { type: 'rate_limited', retryAfterSeconds: 0 }],
        [3, { type: 'server_error' }],
        [3, { type: 'server_error', status: 504, afterApply: true }],
        [4, { type: 'timeout_after_send', delayMs: 900 }],
      ]);
    });
    const plan = random(seed);
    const worker = await harness.startWorker({ adapters, policy: POLICY, concurrency: 6 });
    const runs: { listing: ListingRow; base: string; operations: OperationRow[] }[] = [];
    try {
      for (let index = 0; index < 4; index += 1) {
        const { listing, content } = await createDepopListing();
        listingSkus.add(`${content.item.sku}-D`);
        const operations: OperationRow[] = [];
        for (const [kind, desired] of planOperations(plan)) {
          operations.push(
            await harness.enqueue(
              listing,
              kind,
              desired,
              kind === 'create' || kind === 'relist' ? { content } : {},
            ),
          );
        }
        runs.push({ listing, base: content.item.sku, operations });
      }
      for (const { operations } of runs) {
        for (const op of operations) await done(op, 60_000);
      }
    } finally {
      fake.setChaos(undefined);
      await worker.stop();
    }
    expect(harness.fatalErrors).toEqual([]);

    let succeeded = 0;
    for (const { listing, base, operations } of runs) {
      const products = fake
        .products()
        .filter((product) => product.sku?.startsWith(`${base}-D`) === true);
      // One product per create or relist at most, and never two on sale at once.
      const makers = operations.filter((op) => op.kind === 'create' || op.kind === 'relist').length;
      expect(products.length).toBeLessThanOrEqual(makers);
      expect(
        products.filter((product) => product.status === 'STATUS_ONSALE').length,
      ).toBeLessThanOrEqual(1);
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
          // Depop has no titles, so a read-back never shows one.
          const shown: DesiredListingState = { ...(op.desired as DesiredListingState) };
          delete shown.title;
          const evidence = events.at(-1)?.detail as { remote?: Record<string, unknown> };
          expect(evidence.remote).toMatchObject(shown);
        } else {
          expect(op).toMatchObject({ status: 'failed', success_evidence: null });
        }
      }
      // When the newest operation succeeded, Depop still shows its state on the live product.
      const newest = await harness.operation(operations.at(-1)?.id ?? '');
      if (newest.status === 'succeeded') {
        const row = await harness.listing(listing.id);
        const live = fake.product(row.external_listing_id ?? '');
        const desired = newest.desired as DesiredListingState;
        if (desired.status === 'ended') expect(live?.status).toBe('STATUS_DELETED_ONSALE');
        if (desired.status === 'active') expect(live?.status).toBe('STATUS_ONSALE');
      }
    }
    expect(fake.requests.filter((request) => request.fault !== null).length).toBeGreaterThan(5);
    expect(succeeded).toBeGreaterThan(0);
  }, 120_000);
});

function checksum(text: string): number {
  let sum = 0;
  for (let index = 0; index < text.length; index += 1) sum += text.charCodeAt(index);
  return sum;
}

function pick(
  rng: () => number,
  choices: readonly (readonly [number, FakeDepopFault])[],
): FakeDepopFault {
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

/** Create, then up to three of price changes, ends, and relists. */
function planOperations(rng: () => number): [OperationKind, DesiredListingState][] {
  const plan: [OperationKind, DesiredListingState][] = [['create', {}]];
  let active = true;
  for (let index = 0; index < 1 + Math.floor(rng() * 3); index += 1) {
    if (!active) {
      plan.push(['relist', {}]);
      active = true;
      continue;
    }
    if (rng() < 0.55) {
      plan.push(['price', { priceCents: 1000 + Math.floor(rng() * 9000), currency: 'USD' }]);
    } else {
      plan.push(['end', { status: 'ended' }]);
      active = false;
    }
  }
  return plan;
}

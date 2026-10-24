/**
 * Chaos suite: many operations against a fake marketplace that randomly rate-limits, fails
 * with 5xx (sometimes after applying the change), times out after applying, and serves stale
 * reads. Whatever happens, the engine must never record a success the marketplace does not
 * show, never create a listing twice, and never leave an operation unfinished.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OperationKind } from '@listora/db';
import type { DesiredListingState, FakeFault } from '@listora/marketplaces';

import { OPERATION_TRANSITIONS } from './state-machine.ts';
import { createEngineHarness, type EngineHarness, type ListingRow } from './test-support.ts';
import type { OperationRow } from './transitions.ts';

const LISTINGS_PER_RUN = 8;

/** Small deterministic PRNG (mulberry32), so a failing seed can be replayed. */
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

function pick<T>(rng: () => number, choices: readonly (readonly [number, T])[]): T {
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

/** A plausible sequence of changes for one listing: create, then edits, an end, a relist. */
function planOperations(rng: () => number): [OperationKind, DesiredListingState][] {
  const plan: [OperationKind, DesiredListingState][] = [
    ['create', { status: 'active', title: 'Chaos jacket', priceCents: 5000 }],
  ];
  let active = true;
  const followUps = 1 + Math.floor(rng() * 3);
  for (let index = 0; index < followUps; index += 1) {
    if (!active) {
      plan.push(['relist', { status: 'active' }]);
      active = true;
      continue;
    }
    const kind = pick(rng, [
      [3, 'price'],
      [2, 'revise'],
      [2, 'end'],
    ] as const);
    if (kind === 'price') plan.push(['price', { priceCents: 1000 + Math.floor(rng() * 9000) }]);
    if (kind === 'revise') plan.push(['revise', { title: `Chaos jacket ${String(index)}` }]);
    if (kind === 'end') {
      plan.push(['end', { status: 'ended' }]);
      active = false;
    }
  }
  return plan;
}

/** A fault for one request, or none; writes fail with probability `rate`, reads half as often. */
function chaosFault(rng: () => number, rate: number, action: string): FakeFault | undefined {
  if (action === 'read') {
    if (rng() >= rate / 2) return undefined;
    return pick<FakeFault>(rng, [
      [5, { type: 'stale_read' }],
      [3, { type: 'server_error' }],
      [2, { type: 'timeout_after_send', delayMs: 1_000 }],
    ]);
  }
  if (rng() >= rate) return undefined;
  return pick<FakeFault>(rng, [
    [5, { type: 'rate_limited' }],
    [4, { type: 'server_error' }],
    [4, { type: 'server_error', status: 502, afterApply: true }],
    [4, { type: 'timeout_after_send', delayMs: 1_000 }],
    [1, { type: 'reject' }],
  ]);
}

describe('chaos: injected faults never produce a false success', () => {
  let harness: EngineHarness;

  beforeAll(async () => {
    harness = await createEngineHarness('chaos');
  });

  afterAll(async () => {
    await harness.close();
  });

  it.each([
    [11, 0.3],
    [23, 0.5],
    [47, 0.8],
  ])(
    'seed %i, fault rate %f: every success is verified, nothing is duplicated, nothing is left unfinished',
    async (seed, rate) => {
      // Faults depend only on the listing and how many requests it has had, not on timing
      // across listings, so a seed always replays the same faults.
      const listingIndex = new Map<string, number>();
      const requestCount = new Map<string, number>();
      harness.fake.setChaos(({ action, sku }) => {
        const index = listingIndex.get(sku ?? '');
        if (index === undefined) return undefined;
        const count = requestCount.get(sku ?? '') ?? 0;
        requestCount.set(sku ?? '', count + 1);
        return chaosFault(random(seed * 1_000_003 + index * 7_919 + count), rate, action);
      });
      const plan = random(seed);
      const worker = await harness.startWorker({ concurrency: 8 });

      const runs: { listing: ListingRow; operations: OperationRow[] }[] = [];
      try {
        for (let index = 0; index < LISTINGS_PER_RUN; index += 1) {
          const listing = await harness.createListing();
          listingIndex.set(listing.id, index);
          const operations: OperationRow[] = [];
          for (const [kind, desired] of planOperations(plan)) {
            operations.push(await harness.enqueue(listing, kind, desired));
          }
          runs.push({ listing, operations });
        }
        for (const { operations } of runs) {
          for (const op of operations) {
            await harness.waitForStatus(op.id, ['succeeded', 'failed'], 60_000);
          }
        }
      } finally {
        harness.fake.setChaos(undefined);
        await worker.stop();
      }
      expect(harness.fatalErrors).toEqual([]);

      let succeeded = 0;
      for (const { listing, operations } of runs) {
        // A create is never applied twice, whatever was retried or verified.
        expect(harness.fake.listings('ebay', listing.id).length).toBeLessThanOrEqual(1);

        for (const created of operations) {
          const op = await harness.operation(created.id);
          const events = await harness.events(op.id);

          // The history is complete and every step was a legal transition.
          expect(events[0]).toMatchObject({ from_status: null, to_status: 'queued' });
          for (const [index, event] of events.entries()) {
            if (index === 0) continue;
            const previous = events[index - 1];
            expect(event.from_status).toBe(previous?.to_status);
            if (event.from_status !== null) {
              expect(OPERATION_TRANSITIONS[event.from_status]).toContain(event.to_status);
            }
          }
          expect(events.at(-1)).toMatchObject({ to_status: op.status });

          if (op.status === 'succeeded') {
            succeeded += 1;
            // Success came from a read-back that showed every desired field.
            expect(op.success_evidence).toBe('read_back');
            const evidence = events.at(-1)?.detail as { remote?: Record<string, unknown> };
            expect(evidence.remote).toMatchObject(op.desired);
          } else {
            expect(op).toMatchObject({ status: 'failed', success_evidence: null });
            expect(op.error_message).toEqual(expect.any(String));
          }
        }

        // When the newest operation succeeded, the marketplace still shows its state.
        const newest = await harness.operation(operations.at(-1)?.id ?? '');
        if (newest.status === 'succeeded') {
          expect(harness.fake.listings('ebay', listing.id)).toEqual([
            expect.objectContaining(newest.desired),
          ]);
        }
      }

      const faults = harness.fake.requests.filter(
        (request) => request.fault !== null && listingIndex.has(request.sku ?? ''),
      );
      expect(faults.length).toBeGreaterThan(5);
      expect(succeeded).toBeGreaterThan(0);
    },
    120_000,
  );
});

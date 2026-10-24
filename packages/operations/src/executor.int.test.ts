/**
 * The step executor against misbehaving adapters and concurrent takeovers, run directly
 * (without the job runner) so each case controls exactly when the adapter answers.
 */
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  MarketplaceAdapter,
  MarketplaceCapabilities,
  Outcome,
  RemoteListingState,
} from '@listora/marketplaces';

import { runOperationStep, type StepDependencies } from './executor.ts';
import { listingQueueName, operationJobKey } from './jobs.ts';
import { runJobQueueMaintenance } from './maintenance.ts';
import { LIVENESS_APPLICATION_PREFIX, reapStoppedWorkers } from './recovery.ts';
import { FAST_POLICY, createEngineHarness, type EngineHarness } from './test-support.ts';

const CAPABILITIES: MarketplaceCapabilities = {
  connect: 'oauth',
  create: 'api',
  updatePrice: 'api',
  updateDetails: 'api',
  delist: 'api',
  relist: 'api',
  markSold: 'api',
  verifyRead: 'api',
  importListings: 'none',
  saleDetection: ['poll'],
  imageTransport: 'url_fetch',
  taxonomy: 'static_snapshot',
  pricingData: 'none',
  externalSkuReusable: true,
  limits: {},
};

const ACTIVE: RemoteListingState = {
  found: true,
  externalListingId: 'STUB-1',
  externalUrl: null,
  status: 'active',
  title: 'Stub jacket',
  description: null,
  priceCents: 4500,
  currency: 'USD',
};

function stubAdapter(behavior: {
  execute: () => Promise<Outcome>;
  read?: () => Promise<RemoteListingState>;
}): MarketplaceAdapter {
  return {
    id: 'depop',
    capabilities: () => CAPABILITIES,
    execute: behavior.execute,
    readListing: behavior.read ?? (() => Promise.resolve(ACTIVE)),
  };
}

describe('operation step executor (real Postgres)', () => {
  let harness: EngineHarness;

  beforeAll(async () => {
    harness = await createEngineHarness('executor');
  });

  afterAll(async () => {
    await harness.close();
  });

  function deps(adapter: MarketplaceAdapter, callTimeoutMs = 2_000): StepDependencies {
    return {
      db: harness.db,
      adapters: () => adapter,
      logger: harness.logger,
      policy: FAST_POLICY,
      callTimeoutMs,
      blockedRecheckMs: 60_000,
    };
  }

  async function newCreate() {
    const listing = await harness.createListing('depop');
    const op = await harness.enqueue(listing, 'create', {
      status: 'active',
      title: 'Stub jacket',
      priceCents: 4500,
    });
    return { listing, op, payload: { accountId: harness.accountId, operationId: op.id } };
  }

  it('treats an adapter that throws as an unknown result to verify', async () => {
    const { op, payload } = await newCreate();
    const adapter = stubAdapter({ execute: () => Promise.reject(new Error('socket exploded')) });

    await runOperationStep(deps(adapter), payload, new AbortController().signal);
    expect(await harness.operation(op.id)).toMatchObject({
      status: 'verifying',
      error_code: 'adapter_error',
      success_evidence: null,
    });
  });

  it('treats an adapter that never answers as an unknown result to verify', async () => {
    const { op, payload } = await newCreate();
    const adapter = stubAdapter({ execute: () => new Promise<Outcome>(() => undefined) });

    await runOperationStep(deps(adapter, 100), payload, new AbortController().signal);
    expect(await harness.operation(op.id)).toMatchObject({
      status: 'verifying',
      error_code: 'timeout',
    });
  });

  it('does not count a confirmed write as done when the listing cannot be read back', async () => {
    const { op, payload } = await newCreate();
    const adapter = stubAdapter({
      execute: () => Promise.resolve({ type: 'confirmed', externalListingId: 'STUB-2' }),
      read: () => Promise.reject(new Error('read endpoint down')),
    });

    await runOperationStep(deps(adapter), payload, new AbortController().signal);
    expect(await harness.operation(op.id)).toMatchObject({
      status: 'verifying',
      error_code: 'read_failed',
      success_evidence: null,
    });
    // The id the marketplace returned is kept, so later read-backs can find the listing.
    const listing = await harness.listing(op.listing_id);
    expect(listing).toMatchObject({ external_listing_id: 'STUB-2', last_verified_at: null });
  });

  it('discards a step result when another worker took the operation over', async () => {
    const { op, payload } = await newCreate();
    let release: (outcome: Outcome) => void = () => undefined;
    let started: () => void = () => undefined;
    const executing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const adapter = stubAdapter({
      execute: () =>
        new Promise<Outcome>((resolve) => {
          release = resolve;
          started();
        }),
    });

    const step = runOperationStep(deps(adapter), payload, new AbortController().signal);
    await executing;
    // Another worker recovered the operation meanwhile and moved it on.
    await sql`
      update marketplace_operation set attempts = attempts + 1 where id = ${op.id}
    `.execute(harness.db);
    release({ type: 'confirmed', externalListingId: 'STUB-3' });
    await step;

    expect(await harness.operation(op.id)).toMatchObject({ status: 'running', attempts: 2 });
    const events = await harness.events(op.id);
    expect(events.map((event) => event.to_status)).toEqual(['queued', 'running']);
  });

  it('releases only the locks of worker pools that have no liveness session', async () => {
    const stopped = await newCreate();
    const live = await newCreate();
    const starting = await newCreate();
    const session = new pg.Client({
      connectionString: harness.database.scratch.url,
      application_name: `${LIVENESS_APPLICATION_PREFIX}pool-live`,
    });
    await session.connect();
    const lock = (operationId: string, poolId: string, age: string) => sql`
      update graphile_worker._private_jobs
      set locked_by = ${poolId}, locked_at = now() - ${age}::interval
      where key = ${operationJobKey(operationId)}
    `;
    try {
      await lock(stopped.op.id, 'pool-stopped', '1 minute').execute(harness.db);
      await lock(live.op.id, 'pool-live', '1 minute').execute(harness.db);
      // Locked just now by a pool that has not published its session yet: within the grace.
      await lock(starting.op.id, 'pool-starting', '0 seconds').execute(harness.db);

      expect(await reapStoppedWorkers(harness.db, 30_000)).toEqual(['pool-stopped']);
      const { rows } = await sql<{ key: string; locked_by: string | null }>`
        select key, locked_by from graphile_worker.jobs
        where key in (${operationJobKey(stopped.op.id)}, ${operationJobKey(live.op.id)},
                      ${operationJobKey(starting.op.id)})
        order by key
      `.execute(harness.db);
      expect(Object.fromEntries(rows.map((row) => [row.key, row.locked_by]))).toEqual({
        [operationJobKey(stopped.op.id)]: null,
        [operationJobKey(live.op.id)]: 'pool-live',
        [operationJobKey(starting.op.id)]: 'pool-starting',
      });
      expect(await reapStoppedWorkers(harness.db, 30_000)).toEqual([]);
    } finally {
      await session.end();
    }
  });

  it('deletes listing queues that have no jobs left during daily maintenance', async () => {
    const { listing, op } = await newCreate();
    const queueExists = async (name: string): Promise<boolean> => {
      const { rows } = await sql<{ found: boolean }>`
        select exists (
          select 1 from graphile_worker._private_job_queues where queue_name = ${name}
        ) as found
      `.execute(harness.db);
      return rows[0]?.found === true;
    };
    const active = await harness.createListing('depop');
    await harness.enqueue(active, 'create', { status: 'active', title: 'Kept', priceCents: 100 });
    await sql`select graphile_worker.remove_job(${operationJobKey(op.id)})`.execute(harness.db);
    expect(await queueExists(listingQueueName(listing.id))).toBe(true);

    await runJobQueueMaintenance(harness.database.scratch.url, harness.logger);
    expect(await queueExists(listingQueueName(listing.id))).toBe(false);
    expect(await queueExists(listingQueueName(active.id))).toBe(true);
  });
});

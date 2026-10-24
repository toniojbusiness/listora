/**
 * Test-only helpers for the engine's integration tests (not exported from the package): a
 * migrated scratch database with the job queue, a fake marketplace, and in-process workers
 * with a fast retry schedule.
 */
import type { Selectable } from 'kysely';

import {
  createInventoryItem,
  type Db,
  type Marketplace,
  type MarketplaceListingTable,
  type OperationEventTable,
  type OperationKind,
  type OperationOrigin,
  type OperationStatus,
} from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import {
  FakeMarketplace,
  FakeMarketplaceAdapter,
  type AdapterLookup,
  type DesiredListingState,
} from '@listora/marketplaces';
import { createLogger, type Logger } from '@listora/shared';

import { enqueueOperation } from './commands.ts';
import type { RetryPolicy } from './policy.ts';
import type { OperationRow } from './transitions.ts';
import {
  startOperationWorker,
  type OperationWorker,
  type OperationWorkerOptions,
} from './worker.ts';

export type ListingRow = Selectable<MarketplaceListingTable>;
export type EventRow = Selectable<OperationEventTable>;

/** Seven attempts a few milliseconds apart, without jitter. */
export const FAST_POLICY: RetryPolicy = {
  delaysMs: [10, 20, 30, 40, 50, 60],
  jitter: 0,
  random: () => 0.5,
};

/** The fake's request timeout; a `timeout_after_send` fault answers far later. */
export const FAKE_REQUEST_TIMEOUT_MS = 300;

export interface EngineHarness {
  db: Db;
  database: MigratedDatabase;
  fake: FakeMarketplace;
  accountId: string;
  logger: Logger;
  /** Errors workers reported through `onFatalError`; tests expect none. */
  fatalErrors: Error[];
  /**
   * eBay and Depop use the fake marketplace's API (eBay's reads carry revisions, Depop's carry
   * no freshness marker), Poshmark behaves as an assisted marketplace, and Mercari has no
   * adapter.
   */
  adapters: AdapterLookup;
  startWorker(options?: Partial<OperationWorkerOptions>): Promise<OperationWorker>;
  createListing(marketplace?: Marketplace): Promise<ListingRow>;
  enqueue(
    listing: Pick<ListingRow, 'id'>,
    kind: OperationKind,
    desired: DesiredListingState,
    options?: { idempotencyKey?: string; origin?: OperationOrigin; delistRunId?: string },
  ): Promise<OperationRow>;
  operation(operationId: string): Promise<OperationRow>;
  listing(listingId: string): Promise<ListingRow>;
  events(operationId: string): Promise<EventRow[]>;
  waitForStatus(
    operationId: string,
    statuses: readonly OperationStatus[],
    timeoutMs?: number,
  ): Promise<OperationRow>;
  close(): Promise<void>;
}

export async function createEngineHarness(prefix: string): Promise<EngineHarness> {
  const database = await createMigratedDatabase(prefix, { jobQueue: true, max: 10 });
  const { db } = database;
  const fake = await FakeMarketplace.start();
  const accountId = await insertAccount(db, 'OPS');
  const logger = createLogger({ service: 'operations-test', level: 'silent' });
  const workers = new Set<OperationWorker>();
  const fatalErrors: Error[] = [];
  let sequence = 0;

  const api = (
    marketplace: Marketplace,
    readFreshness: 'revision' | 'none',
  ): FakeMarketplaceAdapter =>
    new FakeMarketplaceAdapter({
      marketplace,
      baseUrl: fake.url,
      requestTimeoutMs: FAKE_REQUEST_TIMEOUT_MS,
      readFreshness,
    });
  const registered = new Map<Marketplace, FakeMarketplaceAdapter>([
    ['ebay', api('ebay', 'revision')],
    ['depop', api('depop', 'none')],
    [
      'poshmark',
      new FakeMarketplaceAdapter({ marketplace: 'poshmark', baseUrl: fake.url, mode: 'assisted' }),
    ],
  ]);
  const adapters: AdapterLookup = (marketplace) => registered.get(marketplace);

  const operation = (operationId: string): Promise<OperationRow> =>
    db
      .selectFrom('marketplace_operation')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('id', '=', operationId)
      .executeTakeFirstOrThrow();

  return {
    db,
    database,
    fake,
    accountId,
    logger,
    fatalErrors,
    adapters,
    async startWorker(options = {}) {
      const worker = await startOperationWorker({
        connectionString: database.scratch.url,
        db,
        adapters,
        logger,
        concurrency: 4,
        policy: FAST_POLICY,
        callTimeoutMs: 2_000,
        pollIntervalMs: 20,
        recoveryIntervalMs: 200,
        recoveryGraceMs: 200,
        blockedRecheckMs: 60_000,
        onFatalError: (error) => {
          fatalErrors.push(error);
        },
        ...options,
      });
      workers.add(worker);
      return {
        poolId: worker.poolId,
        async stop() {
          workers.delete(worker);
          await worker.stop();
        },
      };
    },
    async createListing(marketplace = 'ebay') {
      sequence += 1;
      const item = await createInventoryItem(db, accountId, {
        title: `Test item ${String(sequence)}`,
      });
      return db
        .insertInto('marketplace_listing')
        .values({ account_id: accountId, item_id: item.id, marketplace })
        .returningAll()
        .executeTakeFirstOrThrow();
    },
    async enqueue(listing, kind, desired, options = {}) {
      sequence += 1;
      const { operation: created } = await enqueueOperation(db, {
        accountId,
        listingId: listing.id,
        kind,
        desired,
        idempotencyKey: options.idempotencyKey ?? `test-${prefix}-${String(sequence)}`,
        origin: options.origin ?? 'user',
        delistRunId: options.delistRunId ?? null,
      });
      return created;
    },
    operation,
    listing: (listingId) =>
      db
        .selectFrom('marketplace_listing')
        .selectAll()
        .where('account_id', '=', accountId)
        .where('id', '=', listingId)
        .executeTakeFirstOrThrow(),
    events: (operationId) =>
      db
        .selectFrom('operation_event')
        .selectAll()
        .where('account_id', '=', accountId)
        .where('operation_id', '=', operationId)
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    async waitForStatus(operationId, statuses, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const current = await operation(operationId);
        if (statuses.includes(current.status)) return current;
        if (Date.now() > deadline) {
          throw new Error(
            `operation ${operationId} is ${current.status} (attempt ${String(current.attempts)}), not ${statuses.join(' or ')}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async close() {
      for (const worker of workers) await worker.stop();
      await fake.close();
      await database.close();
    },
  };
}

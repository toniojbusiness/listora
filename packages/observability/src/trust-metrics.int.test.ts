import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createInventoryItem,
  jsonb,
  type ConnectionStatus,
  type Db,
  type Marketplace,
  type OperationKind,
  type OperationStatus,
} from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import { createLogger } from '@listora/shared';

import type { MetricGroup } from './emf.ts';
import { createMetricsEmitter } from './emf.ts';
import { runTrustMetricsTick } from './job.ts';
import { collectCurrentState, collectSettledOperations } from './trust-metrics.ts';

const MINUTE = 60_000;
/** The tick every test publishes at; operations settle in the minute two minutes before it. */
const TICK = new Date('2026-10-24T12:00:00.000Z');
const IN_WINDOW = new Date(TICK.getTime() - 90_000);

const at = (offsetMs: number): Date => new Date(TICK.getTime() + offsetMs);

describe('trust metrics (real Postgres)', () => {
  let database: MigratedDatabase;
  let db: Db;
  let accountId: string;

  beforeAll(async () => {
    database = await createMigratedDatabase('trust_metrics');
    db = database.db;
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    // Each test starts from no data; deleting the account deletes everything it owns.
    await db.deleteFrom('account').execute();
    accountId = await insertAccount(db, 'TM');
  });

  async function listing(marketplace: Marketplace): Promise<string> {
    const item = await createInventoryItem(db, accountId, { title: 'Metrics test item' });
    const row = await db
      .insertInto('marketplace_listing')
      .values({ account_id: accountId, item_id: item.id, marketplace })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** An operation queued at `queuedAt`, now in `status`; settled ones settle at `settledAt`. */
  async function operation(options: {
    marketplace: Marketplace;
    kind: OperationKind;
    status: OperationStatus;
    queuedAt?: Date;
    settledAt?: Date;
    delistRunId?: string;
    listingId?: string;
  }): Promise<string> {
    const listingId = options.listingId ?? (await listing(options.marketplace));
    const queuedAt = options.queuedAt ?? at(-10 * MINUTE);
    const op = await db
      .insertInto('marketplace_operation')
      .values({
        account_id: accountId,
        listing_id: listingId,
        kind: options.kind,
        idempotency_key: `${listingId}-${options.kind}-${String(Math.random())}`,
        desired: jsonb({ status: 'ended' }),
        content: ['create', 'revise', 'relist'].includes(options.kind)
          ? jsonb({ variant: { title: 'Metrics test item' } })
          : null,
        status: options.status,
        origin: options.delistRunId === undefined ? 'user' : 'auto_delist',
        delist_run_id: options.delistRunId ?? null,
        success_evidence: options.status === 'succeeded' ? 'read_back' : null,
        error_code: options.status === 'failed' ? 'validation_failed' : null,
        error_message: options.status === 'failed' ? 'The marketplace refused it.' : null,
        next_attempt_at: ['queued', 'retrying', 'verifying'].includes(options.status) ? TICK : null,
        created_at: queuedAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const event = (to: OperationStatus, createdAt: Date) =>
      db
        .insertInto('operation_event')
        .values({
          account_id: accountId,
          operation_id: op.id,
          from_status: to === 'queued' ? null : 'running',
          to_status: to,
          created_at: createdAt,
        })
        .execute();
    await event('queued', queuedAt);
    if (options.status === 'succeeded' || options.status === 'failed') {
      await event(options.status, options.settledAt ?? IN_WINDOW);
    }
    return op.id;
  }

  /** A sale of the listing's item recorded at `recordedAt`, and its delist run. */
  async function sale(listingId: string, recordedAt: Date): Promise<string> {
    const { item_id: itemId } = await db
      .selectFrom('marketplace_listing')
      .select('item_id')
      .where('id', '=', listingId)
      .executeTakeFirstOrThrow();
    const { id: saleId } = await db
      .insertInto('sale')
      .values({
        account_id: accountId,
        marketplace: 'depop',
        sold_at: recordedAt,
        detection_source: 'webhook',
        created_at: recordedAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('sale_item')
      .values({
        account_id: accountId,
        sale_id: saleId,
        marketplace: 'depop',
        item_id: itemId,
        sale_price_cents: 3000,
      })
      .execute();
    const run = await db
      .insertInto('delist_run')
      .values({ account_id: accountId, sale_id: saleId, item_id: itemId })
      .returning('id')
      .executeTakeFirstOrThrow();
    return run.id;
  }

  async function connection(marketplace: Marketplace, status: ConnectionStatus): Promise<void> {
    await db
      .insertInto('marketplace_connection')
      .values({ account_id: accountId, marketplace, mode: 'api', status })
      .execute();
  }

  async function aiCost(account: string, usageDate: string, costMicros: number): Promise<void> {
    await db
      .insertInto('ai_usage_daily')
      .values({ account_id: account, usage_date: usageDate, calls: 1, cost_micros: costMicros })
      .execute();
  }

  const window = { from: at(-2 * MINUTE), to: at(-MINUTE) };
  const find = (groups: MetricGroup[], metric: string, dimensions: Record<string, string> = {}) =>
    groups.filter(
      (group) =>
        metric in group.values &&
        JSON.stringify(Object.entries(group.dimensions).sort()) ===
          JSON.stringify(Object.entries(dimensions).sort()),
    );

  describe('settled operations', () => {
    it('publishes verified success per marketplace and kind: 1 per success, 0 per failure', async () => {
      await operation({ marketplace: 'ebay', kind: 'create', status: 'succeeded' });
      await operation({ marketplace: 'ebay', kind: 'create', status: 'succeeded' });
      await operation({ marketplace: 'ebay', kind: 'create', status: 'failed' });
      await operation({ marketplace: 'depop', kind: 'price', status: 'succeeded' });

      const groups = await collectSettledOperations(db, window);

      expect(groups).toEqual([
        {
          timestamp: window.from,
          dimensions: { Marketplace: 'ebay', Kind: 'create' },
          values: { VerifiedSuccess: [1, 1, 0] },
        },
        {
          timestamp: window.from,
          dimensions: { Marketplace: 'ebay', Kind: 'create' },
          values: { OperationFailed: [1] },
        },
        {
          timestamp: window.from,
          dimensions: { Marketplace: 'depop', Kind: 'price' },
          values: { VerifiedSuccess: [1] },
        },
        {
          timestamp: window.from,
          dimensions: { Marketplace: 'depop', Kind: 'price' },
          values: { OperationFailed: [0] },
        },
      ]);
    });

    it('counts only operations that settled in the window, never unfinished ones', async () => {
      await operation({
        marketplace: 'ebay',
        kind: 'create',
        status: 'succeeded',
        settledAt: window.from,
      });
      // The window is half-open: settling at its end belongs to the next tick.
      await operation({
        marketplace: 'ebay',
        kind: 'create',
        status: 'failed',
        settledAt: window.to,
      });
      await operation({
        marketplace: 'ebay',
        kind: 'create',
        status: 'succeeded',
        settledAt: at(-3 * MINUTE),
      });
      await operation({ marketplace: 'ebay', kind: 'create', status: 'verifying' });
      await operation({ marketplace: 'ebay', kind: 'create', status: 'canceled' });

      const groups = await collectSettledOperations(db, window);

      expect(groups).toEqual([
        expect.objectContaining({ values: { VerifiedSuccess: [1] } }),
        expect.objectContaining({ values: { OperationFailed: [0] } }),
      ]);
    });

    it('publishes failed delists without dimensions, and nothing when no delist settled', async () => {
      await operation({ marketplace: 'ebay', kind: 'create', status: 'failed' });
      expect(find(await collectSettledOperations(db, window), 'DelistFailed')).toEqual([]);

      await operation({ marketplace: 'ebay', kind: 'end', status: 'failed' });
      await operation({ marketplace: 'poshmark', kind: 'mark_sold', status: 'failed' });
      await operation({ marketplace: 'depop', kind: 'end', status: 'succeeded' });

      expect(find(await collectSettledOperations(db, window), 'DelistFailed')).toEqual([
        { timestamp: window.from, dimensions: {}, values: { DelistFailed: [2] } },
      ]);
    });

    it('publishes delist latency from the recorded sale to the verified delist', async () => {
      const ebayListing = await listing('ebay');
      const run = await sale(ebayListing, at(-5 * MINUTE));
      await operation({
        marketplace: 'ebay',
        kind: 'end',
        status: 'succeeded',
        listingId: ebayListing,
        delistRunId: run,
        settledAt: IN_WINDOW,
      });
      const poshListing = await listing('poshmark');
      await operation({
        marketplace: 'poshmark',
        kind: 'end',
        status: 'succeeded',
        listingId: poshListing,
        delistRunId: await sale(poshListing, at(-4 * MINUTE)),
        settledAt: IN_WINDOW,
      });
      // A failed delist has no latency; neither has a delist the user asked for.
      await operation({ marketplace: 'ebay', kind: 'end', status: 'failed', delistRunId: run });
      await operation({ marketplace: 'ebay', kind: 'end', status: 'succeeded' });

      const groups = await collectSettledOperations(db, window);

      expect(find(groups, 'DelistLatency', { Marketplace: 'ebay' })).toEqual([
        {
          timestamp: window.from,
          dimensions: { Marketplace: 'ebay' },
          values: { DelistLatency: [3.5 * MINUTE] },
        },
      ]);
      expect(find(groups, 'DelistLatency', { Marketplace: 'poshmark' })).toEqual([
        expect.objectContaining({ values: { DelistLatency: [2.5 * MINUTE] } }),
      ]);
    });
  });

  describe('current state', () => {
    it('publishes the count and oldest age of stuck operations per status, zero when none', async () => {
      await operation({
        marketplace: 'ebay',
        kind: 'create',
        status: 'verifying',
        queuedAt: at(-20 * MINUTE),
      });
      await operation({
        marketplace: 'depop',
        kind: 'end',
        status: 'verifying',
        queuedAt: at(-5 * MINUTE),
      });
      await operation({
        marketplace: 'poshmark',
        kind: 'create',
        status: 'needs_user_action',
        queuedAt: at(-90 * MINUTE),
      });
      await operation({ marketplace: 'ebay', kind: 'price', status: 'succeeded' });

      const groups = await collectCurrentState(db, TICK);

      const stuck = (status: string) =>
        find(groups, 'StuckOperations', { Status: status })[0]?.values;
      expect(stuck('verifying')).toEqual({ StuckOperations: [2], OldestStuckOperationAge: [1200] });
      expect(stuck('retrying')).toEqual({ StuckOperations: [0], OldestStuckOperationAge: [0] });
      expect(stuck('needs_user_action')).toEqual({
        StuckOperations: [1],
        OldestStuckOperationAge: [5400],
      });
    });

    it('ages an unverified operation from its latest queueing, and ignores ones waiting for the user', async () => {
      const retried = await operation({
        marketplace: 'ebay',
        kind: 'create',
        status: 'queued',
        queuedAt: at(-3 * 60 * MINUTE),
      });
      // The user retried it 40 minutes ago: it has been unverified since then.
      await db
        .insertInto('operation_event')
        .values({
          account_id: accountId,
          operation_id: retried,
          from_status: 'failed',
          to_status: 'queued',
          created_at: at(-40 * MINUTE),
        })
        .execute();
      await operation({
        marketplace: 'depop',
        kind: 'end',
        status: 'retrying',
        queuedAt: at(-10 * MINUTE),
      });
      await operation({
        marketplace: 'poshmark',
        kind: 'end',
        status: 'needs_user_action',
        queuedAt: at(-5 * 60 * MINUTE),
      });

      const groups = await collectCurrentState(db, TICK);

      expect(find(groups, 'OldestUnverifiedOperationAge')).toEqual([
        { timestamp: TICK, dimensions: {}, values: { OldestUnverifiedOperationAge: [2400] } },
      ]);
    });

    it('publishes zero unverified age when every operation is settled or waiting for the user', async () => {
      await operation({ marketplace: 'poshmark', kind: 'end', status: 'needs_user_action' });
      const groups = await collectCurrentState(db, TICK);
      expect(find(groups, 'OldestUnverifiedOperationAge')[0]?.values).toEqual({
        OldestUnverifiedOperationAge: [0],
      });
    });

    it("publishes each account's AI cost for the tick's UTC day, in dollars", async () => {
      const other = await insertAccount(db, 'TO');
      await aiCost(accountId, '2026-10-24', 812_500);
      await aiCost(other, '2026-10-24', 1_000);
      await aiCost(other, '2026-10-23', 5_000_000);
      const idle = await insertAccount(db, 'TI');
      await aiCost(idle, '2026-10-24', 0);

      const groups = await collectCurrentState(db, TICK);

      expect(find(groups, 'AiDailyCostUsd', { AccountId: accountId })[0]?.values).toEqual({
        AiDailyCostUsd: [0.8125],
      });
      expect(find(groups, 'AiDailyCostUsd', { AccountId: other })[0]?.values).toEqual({
        AiDailyCostUsd: [0.001],
      });
      expect(find(groups, 'AiDailyCostUsd', { AccountId: idle })).toEqual([]);
      // 23:59:59 UTC is still the same day; the day changes at midnight UTC, not locally.
      const late = await collectCurrentState(db, new Date('2026-10-24T23:59:59.000Z'));
      expect(find(late, 'AiDailyCostUsd', { AccountId: accountId })).toHaveLength(1);
      const next = await collectCurrentState(db, new Date('2026-10-25T00:00:00.000Z'));
      expect(next.filter((group) => 'AiDailyCostUsd' in group.values)).toEqual([]);
    });

    it('publishes connection health and the connections that need relinking', async () => {
      await connection('ebay', 'connected');
      await connection('depop', 'reauth_required');
      await connection('mercari', 'revoked');
      await connection('poshmark', 'degraded');
      const other = await insertAccount(db, 'TC');
      await db
        .insertInto('marketplace_connection')
        .values({ account_id: other, marketplace: 'ebay', mode: 'api', status: 'connected' })
        .execute();

      const groups = await collectCurrentState(db, TICK);

      expect(
        groups
          .filter((group) => 'MarketplaceConnections' in group.values)
          .map((group) => [group.dimensions, group.values.MarketplaceConnections]),
      ).toEqual([
        [{ Marketplace: 'depop', Status: 'reauth_required' }, [1]],
        [{ Marketplace: 'ebay', Status: 'connected' }, [2]],
        [{ Marketplace: 'mercari', Status: 'revoked' }, [1]],
        [{ Marketplace: 'poshmark', Status: 'degraded' }, [1]],
      ]);
      expect(find(groups, 'ConnectionsNeedingRelink')[0]?.values).toEqual({
        ConnectionsNeedingRelink: [2],
      });
    });

    it('publishes zero connections needing relink when there are none', async () => {
      const groups = await collectCurrentState(db, TICK);
      expect(find(groups, 'ConnectionsNeedingRelink')[0]?.values).toEqual({
        ConnectionsNeedingRelink: [0],
      });
    });

    it('counts account and connection deletions unfinished past their 8-day deadline', async () => {
      const overdue = () =>
        collectCurrentState(db, TICK).then((groups) => find(groups, 'OverdueDeletions')[0]);
      expect((await overdue())?.values).toEqual({ OverdueDeletions: [0] });
      const daysBefore = (days: number) => new Date(TICK.getTime() - days * 86_400_000);
      const account = await db
        .insertInto('account_deletion')
        .values({
          auth_provider: 'dev',
          auth_subject_sha256: Buffer.alloc(32, 7),
          requested_at: daysBefore(9),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const connections = await db
        .insertInto('connection_deletion')
        .values([
          {
            connection_id: crypto.randomUUID(),
            marketplace: 'ebay',
            reason: 'unlinked',
            revocation: 'none',
            requested_at: daysBefore(8.5),
          },
          {
            connection_id: crypto.randomUUID(),
            marketplace: 'ebay',
            reason: 'unlinked',
            revocation: 'none',
            requested_at: daysBefore(7),
          },
        ])
        .returning('id')
        .execute();
      try {
        expect(await overdue()).toEqual({
          timestamp: TICK,
          dimensions: {},
          values: { OverdueDeletions: [2] },
        });
      } finally {
        await db.deleteFrom('account_deletion').where('id', '=', account.id).execute();
        await db
          .deleteFrom('connection_deletion')
          .where(
            'id',
            'in',
            connections.map((row) => row.id),
          )
          .execute();
      }
    });
  });

  describe('the job', () => {
    const logger = createLogger({ service: 'test', level: 'silent' });

    async function tick(payload: unknown, now: Date): Promise<Record<string, unknown>[]> {
      const lines: string[] = [];
      const emitter = createMetricsEmitter({
        service: 'worker',
        write: (line) => lines.push(line),
      });
      await runTrustMetricsTick({ db, emitter, logger, now: () => now }, payload);
      return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    }

    const metricNames = (lines: Record<string, unknown>[]) =>
      lines.flatMap((line) =>
        (
          line['_aws'] as { CloudWatchMetrics: { Metrics: { Name: string }[] }[] }
        ).CloudWatchMetrics.flatMap((directive) => directive.Metrics.map((metric) => metric.Name)),
      );

    it('writes EMF lines for the operations that settled a minute before, and the state now', async () => {
      await operation({ marketplace: 'ebay', kind: 'end', status: 'failed' });
      await operation({
        marketplace: 'ebay',
        kind: 'create',
        status: 'verifying',
        queuedAt: at(-45 * MINUTE),
      });
      await connection('ebay', 'reauth_required');
      await aiCost(accountId, '2026-10-24', 900_000);

      const lines = await tick({ _cron: { ts: TICK.toISOString(), backfilled: false } }, at(5_000));

      expect(new Set(metricNames(lines))).toEqual(
        new Set([
          'VerifiedSuccess',
          'OperationFailed',
          'DelistFailed',
          'StuckOperations',
          'OldestStuckOperationAge',
          'OldestUnverifiedOperationAge',
          'AiDailyCostUsd',
          'MarketplaceConnections',
          'ConnectionsNeedingRelink',
          'OverdueDeletions',
        ]),
      );
      for (const line of lines) {
        expect(line).toMatchObject({
          service: 'worker',
          _aws: { CloudWatchMetrics: [{ Namespace: 'Listora' }] },
        });
      }
      const line = (metric: string) => lines.find((candidate) => metric in candidate);
      expect(line('DelistFailed')).toMatchObject({
        DelistFailed: 1,
        _aws: { Timestamp: window.from.getTime(), CloudWatchMetrics: [{ Dimensions: [[]] }] },
      });
      expect(line('VerifiedSuccess')).toMatchObject({
        Marketplace: 'ebay',
        Kind: 'end',
        VerifiedSuccess: 0,
        _aws: { CloudWatchMetrics: [{ Dimensions: [['Marketplace', 'Kind'], ['Marketplace']] }] },
      });
      expect(line('OperationFailed')).toMatchObject({
        Marketplace: 'ebay',
        Kind: 'end',
        OperationFailed: 1,
        _aws: { CloudWatchMetrics: [{ Dimensions: [['Marketplace', 'Kind']] }] },
      });
      expect(line('OldestUnverifiedOperationAge')).toMatchObject({
        OldestUnverifiedOperationAge: 45 * 60 + 5,
        _aws: { Timestamp: at(5_000).getTime(), CloudWatchMetrics: [{ Dimensions: [[]] }] },
      });
      expect(line('AiDailyCostUsd')).toMatchObject({
        AccountId: accountId,
        AiDailyCostUsd: 0.9,
        _aws: { CloudWatchMetrics: [{ Dimensions: [['AccountId'], []] }] },
      });
      expect(line('ConnectionsNeedingRelink')).toMatchObject({ ConnectionsNeedingRelink: 1 });
    });

    it('fills in settled operations for a missed minute, without stale current state', async () => {
      await operation({ marketplace: 'ebay', kind: 'end', status: 'failed' });
      await operation({ marketplace: 'ebay', kind: 'create', status: 'verifying' });

      const backfilled = await tick(
        { _cron: { ts: TICK.toISOString(), backfilled: true } },
        at(30 * MINUTE),
      );
      expect(new Set(metricNames(backfilled))).toEqual(
        new Set(['VerifiedSuccess', 'OperationFailed', 'DelistFailed']),
      );
    });

    it('publishes the current state from a scheduled tick that runs late (a busy queue)', async () => {
      await operation({
        marketplace: 'ebay',
        kind: 'create',
        status: 'queued',
        queuedAt: at(-40 * MINUTE),
      });

      const late = await tick(
        { _cron: { ts: TICK.toISOString(), backfilled: false } },
        at(10 * MINUTE),
      );
      expect(late.find((line) => 'OldestUnverifiedOperationAge' in line)).toMatchObject({
        OldestUnverifiedOperationAge: 50 * 60,
        _aws: { Timestamp: at(10 * MINUTE).getTime() },
      });
    });

    it('skips a job without a cron timestamp', async () => {
      expect(await tick({}, TICK)).toEqual([]);
      expect(await tick({ _cron: { ts: 'yesterday' } }, TICK)).toEqual([]);
    });
  });
});

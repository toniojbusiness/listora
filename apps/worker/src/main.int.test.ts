import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createInventoryItem, type Marketplace } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import { FakeMarketplace } from '@listora/marketplaces';
import { enqueueOperation, LIVENESS_APPLICATION_PREFIX } from '@listora/operations';
import { startNodeProcess, type StartedProcess } from '@listora/testing';

const entry = fileURLToPath(new URL('main.ts', import.meta.url));
const LIFECYCLE = new Set(['worker ready', 'shutting down', 'shutdown complete']);

describe('worker process (real Postgres)', () => {
  let database: MigratedDatabase;
  let fake: FakeMarketplace;
  let accountId: string;
  const workers: StartedProcess[] = [];

  beforeAll(async () => {
    database = await createMigratedDatabase('worker', { jobQueue: true });
    fake = await FakeMarketplace.start();
    accountId = await insertAccount(database.db, 'WRK');
  });

  afterAll(async () => {
    await fake.close();
    await database.close();
  });

  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.stop('SIGKILL');
    fake.clearFaults();
  });

  async function startWorker(env: NodeJS.ProcessEnv = {}): Promise<StartedProcess> {
    const worker = startNodeProcess(entry, {
      PATH: process.env['PATH'],
      DATABASE_URL: database.scratch.url,
      FAKE_MARKETPLACE_URL: fake.url,
      LOG_LEVEL: 'info',
      ...env,
    });
    workers.push(worker);
    await worker.waitForLog((line) => line['msg'] === 'worker ready', 20_000);
    return worker;
  }

  async function createOperation(marketplace: Marketplace = 'ebay') {
    const item = await createInventoryItem(database.db, accountId, { title: 'Process test item' });
    const listing = await database.db
      .insertInto('marketplace_listing')
      .values({ account_id: accountId, item_id: item.id, marketplace })
      .returningAll()
      .executeTakeFirstOrThrow();
    const { operation } = await enqueueOperation(database.db, {
      accountId,
      listingId: listing.id,
      kind: 'create',
      idempotencyKey: `process-${listing.id}`,
      desired: { status: 'active', title: 'Process test jacket', priceCents: 5500 },
      origin: 'user',
    });
    return { listing, operation };
  }

  async function waitForOperation(operationId: string, status: string, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const op = await database.db
        .selectFrom('marketplace_operation')
        .selectAll()
        .where('id', '=', operationId)
        .executeTakeFirstOrThrow();
      if (op.status === status) return op;
      if (Date.now() > deadline) throw new Error(`operation is ${op.status}, not ${status}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it('starts, reports ready, and exits 0 on SIGTERM', async () => {
    const worker = await startWorker();

    expect(await worker.stop('SIGTERM')).toBe(0);
    const lifecycle = worker.logs
      .map((line) => line['msg'])
      .filter((msg) => typeof msg === 'string' && LIFECYCLE.has(msg));
    expect(lifecycle).toEqual(['worker ready', 'shutting down', 'shutdown complete']);
  });

  it('runs an operation to a verified success', async () => {
    await startWorker();
    const { listing, operation } = await createOperation();

    const done = await waitForOperation(operation.id, 'succeeded');
    expect(done.success_evidence).toBe('read_back');
    expect(fake.listings('ebay', listing.id)).toHaveLength(1);
  });

  // Recovery waits for the surviving worker's next check (5 s) after the lock's grace (5 s).
  it('recovers the job of a worker killed mid-operation without sending it twice', async () => {
    const { listing, operation } = await createOperation();
    fake.inject({ action: 'create', sku: listing.id, fault: { type: 'hang', afterApply: true } });

    const doomed = await startWorker();
    await fake.waitForRequest((request) => request.sku === listing.id, 20_000);
    expect((await waitForOperation(operation.id, 'running')).attempts).toBe(1);
    await doomed.stop('SIGKILL');

    await startWorker();
    const done = await waitForOperation(operation.id, 'succeeded');
    expect(done.success_evidence).toBe('read_back');
    const transitions = await database.db
      .selectFrom('operation_event')
      .select(['from_status', 'to_status', 'detail'])
      .where('operation_id', '=', operation.id)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    expect(transitions.map((event) => `${event.from_status ?? 'new'}>${event.to_status}`)).toEqual([
      'new>queued',
      'queued>running',
      'running>verifying',
      'verifying>succeeded',
    ]);
    expect(transitions[2]?.detail).toMatchObject({ recovered: true });
    // The change reached the marketplace once, and the recovery only read it back.
    const sent = fake.requests.filter((request) => request.sku === listing.id);
    expect(sent.map((request) => request.action)).toEqual(['create', 'read']);
    expect(fake.listings('ebay', listing.id)).toHaveLength(1);
  }, 60_000);

  it('after a crash before the change landed, schedules a retry instead of resending blindly', async () => {
    const { listing, operation } = await createOperation();
    fake.inject({ action: 'create', sku: listing.id, fault: { type: 'hang', afterApply: false } });

    const doomed = await startWorker();
    await fake.waitForRequest((request) => request.sku === listing.id, 20_000);
    await doomed.stop('SIGKILL');

    await startWorker();
    const retrying = await waitForOperation(operation.id, 'retrying');
    expect(retrying).toMatchObject({ error_code: 'not_applied', success_evidence: null });
    expect(retrying.next_attempt_at?.getTime()).toBeGreaterThan(Date.now() + 15_000);
    const sent = fake.requests.filter((request) => request.sku === listing.id);
    expect(sent.map((request) => request.action)).toEqual(['create', 'read']);
    expect(fake.listings('ebay', listing.id)).toEqual([]);
  }, 60_000);

  it('exits at once when it loses its liveness session', async () => {
    const worker = await startWorker();
    await sql`
      select pg_terminate_backend(pid) from pg_stat_activity
      where application_name like ${`${LIVENESS_APPLICATION_PREFIX}pool-%`}
        and datname = current_database()
    `.execute(database.db);

    expect(await worker.waitForExit(10_000)).toBe(1);
    expect(worker.logs).toContainEqual(
      expect.objectContaining({ msg: 'worker cannot continue safely; exiting' }),
    );
  });

  it('refuses to start with invalid configuration, without echoing values', async () => {
    const worker = startNodeProcess(entry, {
      PATH: process.env['PATH'],
      DATABASE_URL: 'mysql://listora:hunter2-secret@127.0.0.1/listora',
      LOG_LEVEL: 'invalid-level-value',
    });
    workers.push(worker);

    expect(await worker.waitForExit()).toBe(1);
    expect(worker.stderr).toContain('DATABASE_URL must be a postgres:// URL');
    expect(worker.stderr).toContain('LOG_LEVEL must be one of');
    expect(worker.stderr).not.toContain('hunter2-secret');
    expect(worker.stderr).not.toContain('invalid-level-value');
    expect(worker.logs).toEqual([]);
  });

  it('exits non-zero when the database is unreachable', async () => {
    const worker = startNodeProcess(entry, {
      PATH: process.env['PATH'],
      DATABASE_URL: 'postgres://listora@127.0.0.1:1/listora_test',
    });
    workers.push(worker);

    expect(await worker.waitForExit(20_000)).toBe(1);
    expect(worker.logs).toContainEqual(expect.objectContaining({ msg: 'worker failed to start' }));
  });
});

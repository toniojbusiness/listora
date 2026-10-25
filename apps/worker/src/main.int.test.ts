import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { startAccountDeletion } from '@listora/accounts';
import {
  encodeAnalysisAnswer,
  graphileAnalysisJobs,
  ITEM_ANALYSIS_OUTPUT_NAME,
  requestAnalysis,
  type ItemAnalysisOutput,
} from '@listora/analysis';
import { createInventoryItem, inTransaction, type Marketplace } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import { FakeEbay, FakeMarketplace } from '@listora/marketplaces';
import { contentWith } from '@listora/marketplaces/testing';
import { TRUST_METRICS_TASK } from '@listora/observability';
import { enqueueOperation, LIVENESS_APPLICATION_PREFIX } from '@listora/operations';
import { graphilePhotoJobs, itemPhotoSet, storageKeys } from '@listora/photos';
import { photoSetHash, sha256Hex } from '@listora/shared';
import { createStorage, type ObjectStorage } from '@listora/storage';
import { startNodeProcess, type StartedProcess } from '@listora/testing';

import { AI_SPEND_CHECK_TASK } from './features/ai-spend-check.ts';

const entry = fileURLToPath(new URL('main.ts', import.meta.url));
const LIFECYCLE = new Set(['worker ready', 'shutting down', 'shutdown complete']);

describe('worker process (real Postgres)', () => {
  let database: MigratedDatabase;
  let fake: FakeMarketplace;
  let accountId: string;
  let storageDir: string;
  let fixturesDir: string;
  let storage: ObjectStorage;
  const workers: StartedProcess[] = [];

  beforeAll(async () => {
    database = await createMigratedDatabase('worker', { jobQueue: true });
    fake = await FakeMarketplace.start();
    accountId = await insertAccount(database.db, 'WRK');
    storageDir = await mkdtemp(join(tmpdir(), 'listora-worker-storage-'));
    fixturesDir = await mkdtemp(join(tmpdir(), 'listora-worker-fixtures-'));
    storage = createStorage({
      driver: 'local',
      rootDir: storageDir,
      baseUrl: 'http://127.0.0.1:3000',
      signingSecret: undefined,
    });
  });

  afterAll(async () => {
    await fake.close();
    await database.close();
    await rm(storageDir, { recursive: true, force: true });
    await rm(fixturesDir, { recursive: true, force: true });
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
      STORAGE_LOCAL_DIR: storageDir,
      AI_PROVIDER: 'fake',
      AI_FAKE_FIXTURES_DIR: fixturesDir,
      LOG_LEVEL: 'info',
      ...env,
    });
    workers.push(worker);
    await worker.waitForLog((line) => line['msg'] === 'worker ready', 20_000);
    return worker;
  }

  async function createOperation(
    marketplace: Marketplace = 'ebay',
    connectionId: string | null = null,
  ) {
    const item = await createInventoryItem(database.db, accountId, { title: 'Process test item' });
    const listing = await database.db
      .insertInto('marketplace_listing')
      .values({ account_id: accountId, item_id: item.id, marketplace, connection_id: connectionId })
      .returningAll()
      .executeTakeFirstOrThrow();
    const { operation } = await enqueueOperation(database.db, {
      accountId,
      listingId: listing.id,
      kind: 'create',
      idempotencyKey: `process-${listing.id}`,
      content: contentWith({ title: 'Process test jacket', priceCents: 5500 }),
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

  /** An item with one tag photo, attached as the API attaches it: the row and its job together. */
  async function itemWithPhoto(seed: number) {
    const item = await createInventoryItem(database.db, accountId, { title: 'Analysis test item' });
    const upload = new Uint8Array(
      await sharp({
        create: { width: 1600, height: 1200, channels: 3, background: { r: seed, g: 90, b: 160 } },
      })
        .jpeg()
        .toBuffer(),
    );
    const storageKey = storageKeys.upload(accountId, crypto.randomUUID());
    await storage.put(storageKey, upload, { contentType: 'image/jpeg' });
    const photo = await inTransaction(database.db, async (trx) => {
      const row = await trx
        .insertInto('photo')
        .values({
          account_id: accountId,
          item_id: item.id,
          position: 0,
          role: 'tag',
          storage_key: storageKey,
          width: 1600,
          height: 1200,
          sha256: sha256Hex(upload),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await graphilePhotoJobs.enqueue(trx, { accountId, photoId: row.id });
      return row;
    });
    return { itemId: item.id, photoId: photo.id, hash: photoSetHash([sha256Hex(upload)]) };
  }

  /** Makes the fake provider answer for the photo set, as `AI_FAKE_FIXTURES_DIR` files do. */
  async function writeAnalysisFixture(hash: string, output: ItemAnalysisOutput) {
    const fixture = { outputs: { [ITEM_ANALYSIS_OUTPUT_NAME]: encodeAnalysisAnswer(output) } };
    await writeFile(join(fixturesDir, `${hash}.json`), JSON.stringify(fixture));
  }

  async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function readyPhotoSet(itemId: string) {
    return waitFor(
      () => itemPhotoSet(database.db, accountId, itemId),
      (set) => set?.photos.every((photo) => photo.status === 'ready') === true,
      'the photo to be processed',
    );
  }

  function analyses(itemId: string) {
    return database.db
      .selectFrom('ai_analysis')
      .selectAll()
      .where('item_id', '=', itemId)
      .orderBy('created_at')
      .execute();
  }

  async function startAnalysis(itemId: string, hash: string) {
    const { row } = await inTransaction(database.db, (trx) =>
      requestAnalysis(trx, graphileAnalysisJobs, {
        accountId,
        itemId,
        photoSetHash: hash,
        tier: 'standard',
        model: 'claude-haiku-5-5',
        requestedByUserId: null,
      }),
    );
    return row;
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

  it('publishes trust metrics as CloudWatch EMF lines on its stdout', async () => {
    const worker = await startWorker();
    const { operation } = await createOperation();
    await waitForOperation(operation.id, 'succeeded');
    const settled = await database.db
      .selectFrom('operation_event')
      .select('created_at')
      .where('operation_id', '=', operation.id)
      .where('to_status', '=', 'succeeded')
      .executeTakeFirstOrThrow();

    // The cron tick whose window holds the success: the minute that starts 90 s after it.
    const tick = new Date(settled.created_at.getTime() + 90_000);
    await sql`
      select graphile_worker.add_job(
        ${TRUST_METRICS_TASK},
        json_build_object('_cron', json_build_object('ts', ${tick.toISOString()}::text,
          'backfilled', false))
      )
    `.execute(database.db);

    const line = await worker.waitForLog(
      (candidate) => candidate['VerifiedSuccess'] !== undefined && candidate['Kind'] === 'create',
      20_000,
    );
    expect(line).toMatchObject({
      service: 'worker',
      Marketplace: 'ebay',
      Kind: 'create',
      _aws: {
        CloudWatchMetrics: [
          {
            Namespace: 'Listora',
            Dimensions: [['Marketplace', 'Kind'], ['Marketplace']],
            Metrics: [{ Name: 'VerifiedSuccess', Unit: 'Count' }],
          },
        ],
      },
    });
    // Earlier tests' operations may have settled in the same minute: every one succeeded.
    expect([line['VerifiedSuccess']].flat()).toContain(1);
    expect([line['VerifiedSuccess']].flat().every((value) => value === 1)).toBe(true);
    // The same tick publishes the current state too.
    await worker.waitForLog(
      (candidate) => typeof candidate['OldestUnverifiedOperationAge'] === 'number',
    );
  });

  it('lists eBay operations on the fake eBay with EBAY_ENV=fake, for the bound connection only', async () => {
    const ebay = await FakeEbay.start();
    try {
      const connection = await database.db
        .insertInto('marketplace_connection')
        .values({
          account_id: accountId,
          marketplace: 'ebay',
          mode: 'api',
          external_user_id: 'listora_dev_seller',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await startWorker({
        EBAY_ENV: 'fake',
        EBAY_FAKE_URL: ebay.url,
        EBAY_USER_CONNECTION_ID: connection.id,
      });
      const { listing, operation } = await createOperation('ebay', connection.id);
      // eBay's reads carry no freshness marker, so a matching read waits for a second one.
      const waiting = await waitForOperation(operation.id, 'verifying');
      expect(waiting.error_code).toBe('confirming');
      expect(ebay.listings(listing.id)).toMatchObject([
        { title: 'Process test jacket', price: '55.0', status: 'Active', trackedBySku: true },
      ]);
      expect(fake.listings('ebay', listing.id)).toEqual([]);

      // A listing without that connection never lists on the configured seller's account.
      const unbound = await createOperation();
      const refused = await waitForOperation(unbound.operation.id, 'failed');
      expect(refused).toMatchObject({ error_code: 'reauth_required', success_evidence: null });
      expect(ebay.listings(unbound.listing.id)).toEqual([]);
    } finally {
      await ebay.close();
    }
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

  it('processes photos, then analyzes the item and escalates it on its own', async () => {
    await startWorker();
    const { itemId, hash } = await itemWithPhoto(40);
    await writeAnalysisFixture(hash, analysisAnswer({ looksVintage: true }));
    expect((await readyPhotoSet(itemId))?.hash).toBe(hash);

    const fast = await startAnalysis(itemId, hash);
    const [standard, premium] = await waitFor(
      () => analyses(itemId),
      (rows) => rows.length === 2 && rows.every((row) => row.status === 'succeeded'),
      'the analysis and its escalation',
    );
    expect(standard).toMatchObject({ id: fast.id, tier: 'standard', attempts: 1 });
    expect(standard?.output).toMatchObject({
      needsEscalation: true,
      escalationReason: 'It looks vintage.',
      details: { brand: { value: "Levi's" } },
    });
    expect(premium).toMatchObject({
      tier: 'premium',
      model: 'claude-sonnet-5-5',
      escalated_from_analysis_id: fast.id,
    });
    expect(premium?.output).toMatchObject({ needsEscalation: false });
    const usage = await database.db
      .selectFrom('ai_usage_event')
      .select(['model', 'outcome'])
      .where('item_id', '=', itemId)
      .orderBy('created_at')
      .execute();
    expect(usage.map((event) => event.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
  }, 60_000);

  it('records a failed analysis with its reason, and runs it again when asked', async () => {
    await startWorker({ AI_AUTO_ESCALATE: 'off' });
    const { itemId, hash } = await itemWithPhoto(200);
    await readyPhotoSet(itemId);

    // No fixture for these photos: the fake provider fails the way a real one can.
    const analysis = await startAnalysis(itemId, hash);
    const [failed] = await waitFor(
      () => analyses(itemId),
      (rows) => rows[0]?.status === 'failed',
      'the analysis to fail',
    );
    expect(failed).toMatchObject({
      id: analysis.id,
      error_code: 'fixture_missing',
      error_retryable: false,
      output: null,
    });

    await writeAnalysisFixture(hash, analysisAnswer({ looksVintage: true }));
    expect(await startAnalysis(itemId, hash)).toMatchObject({ id: analysis.id, status: 'pending' });
    const [succeeded, ...others] = await waitFor(
      () => analyses(itemId),
      (rows) => rows[0]?.status === 'succeeded',
      'the analysis to run again',
    );
    expect(succeeded).toMatchObject({ id: analysis.id, error_code: null });
    // AI_AUTO_ESCALATE=off leaves the premium identification to the user.
    expect(others).toEqual([]);
  }, 60_000);

  it('serves Poshmark assisted: a user task, and nothing sent to any marketplace', async () => {
    await startWorker();
    const { listing, operation } = await createOperation('poshmark');

    const waiting = await waitForOperation(operation.id, 'needs_user_action');
    expect(waiting.success_evidence).toBeNull();
    const tasks = await database.db
      .selectFrom('user_task')
      .select(['kind', 'deep_link', 'listing_id', 'status'])
      .where('operation_id', '=', operation.id)
      .execute();
    expect(tasks).toEqual([
      {
        kind: 'list_manually',
        deep_link: 'https://poshmark.com/',
        listing_id: listing.id,
        status: 'open',
      },
    ]);
    expect(fake.requests.filter((request) => request.sku === listing.id)).toEqual([]);
  });

  it('finishes an account deletion the API committed', async () => {
    await startWorker();
    const { deletionId } = await database.db.transaction().execute((trx) =>
      startAccountDeletion(trx, {
        identity: { provider: 'dev', subject: 'wendy.worker@example.com' },
        grants: [],
      }),
    );

    const deadline = Date.now() + 20_000;
    for (;;) {
      const left = await database.db
        .selectFrom('account_deletion')
        .select('id')
        .where('id', '=', deletionId)
        .executeTakeFirst();
      if (!left) break;
      if (Date.now() > deadline) throw new Error('the account deletion did not finish');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

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

  it('schedules the hourly AI spend check and logs its alerts', async () => {
    const worker = await startWorker({ AI_DAILY_BUDGET_USD: '1.00' });
    await vi.waitFor(
      async () => {
        const crontabs = await sql<{ identifier: string }>`
          select identifier from graphile_worker._private_known_crontabs
        `.execute(database.db);
        expect(crontabs.rows.map((row) => row.identifier)).toContain(AI_SPEND_CHECK_TASK);
      },
      { timeout: 10_000, interval: 50 },
    );

    await sql`
      insert into ai_usage_daily (account_id, usage_date, calls, cost_micros)
      values (${accountId}, (now() at time zone 'UTC')::date, 3, 1200000)
      on conflict (account_id, usage_date) do update set cost_micros = excluded.cost_micros
    `.execute(database.db);
    await sql`select graphile_worker.add_job(${AI_SPEND_CHECK_TASK})`.execute(database.db);

    const summary = await worker.waitForLog((line) => line['event'] === 'ai_spend_check', 20_000);
    expect(summary).toMatchObject({ service: 'worker', accountsOverDailyBudget: 1 });
    expect(worker.logs).toContainEqual(
      expect.objectContaining({
        event: 'ai_spend_alert',
        alert: 'account_daily_budget',
        severity: 'over',
        accountId,
        spentMicros: 1_200_000,
        limitMicros: 1_000_000,
      }),
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

/** A valid analysis answer for a tag photo; the tests override what they look at. */
function analysisAnswer(overrides: Partial<ItemAnalysisOutput> = {}): ItemAnalysisOutput {
  return {
    attributes: {
      brand: { value: "Levi's", confidence: 0.95, source: 'tag_text' },
      productName: { value: '501 Original', confidence: 0.8, source: 'tag_text' },
      styleNumber: null,
      rnNumber: null,
      upc: null,
      department: { value: 'men', confidence: 0.9, source: 'photo' },
      category: { value: 'clothing/bottoms', confidence: 0.95, source: 'photo' },
      subcategory: { value: 'jeans', confidence: 0.9, source: 'photo' },
      sizeLabel: { value: 'M', confidence: 0.9, source: 'tag_text' },
      sizeSystem: { value: 'letter', confidence: 0.9, source: 'tag_text' },
      colors: { values: ['blue'], confidence: 0.9, source: 'photo' },
      pattern: { value: 'solid', confidence: 0.85, source: 'photo' },
      materials: { values: ['cotton'], confidence: 0.85, source: 'tag_text' },
      condition: { value: 'pre_owned_good', confidence: 0.8, source: 'photo' },
      conditionNotes: null,
      flaws: null,
      keywords: { values: ['denim'], confidence: 0.7, source: 'photo' },
    },
    title: { value: "Levi's 501 Original Jeans, Men's M", confidence: 0.85 },
    description: { value: "Men's Levi's 501 jeans in blue.", confidence: 0.8 },
    variants: {
      ebay: { title: "Levi's 501 Original Jeans Mens M Blue Denim", description: 'Blue jeans.' },
      depop: {
        title: "Levi's 501s",
        description: 'Classic blue 501s.',
        hashtags: ['levis', 'denim'],
      },
      poshmark: { title: "Levi's 501 Original Jeans", description: 'A wardrobe staple.' },
      mercari: { title: "Levi's 501 Jeans Men's M", description: 'Blue jeans.' },
    },
    priceEstimate: { lowCents: 2_000, midCents: 2_800, highCents: 3_500, confidence: 0.6 },
    looksVintage: false,
    looksDesigner: false,
    needsEscalation: false,
    escalationReason: null,
    ...overrides,
  };
}

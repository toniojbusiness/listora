/**
 * The browser runner end to end, as processes (real Postgres, the fake marketplace site, a real
 * headless Chromium): the worker hands an automated step over, starts the runner as a child
 * process, the runner publishes the listing through the seller's session and the engine
 * confirms it by read-back, a CAPTCHA falls back to the user and asks for a relink, a sale
 * check records the seller's sales, and the idle runner exits.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  automationProfile,
  browserRunnerAlive,
  FakeAutomationSite,
  linkAutomationSession,
  requestSaleCheck,
  standInProfile,
} from '@listora/automation';
import { createInventoryItem } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import type { ListingContent } from '@listora/marketplaces';
import { contentWith } from '@listora/marketplaces/testing';
import { enqueueOperation } from '@listora/operations';
import { createLogger } from '@listora/shared';
import { startNodeProcess, type StartedProcess } from '@listora/testing';
import { LocalTokenVault, SessionVault } from '@listora/connections';

const workerEntry = fileURLToPath(new URL('../main.ts', import.meta.url));
const runnerEntry = fileURLToPath(new URL('main.ts', import.meta.url));

describe('browser runner process (real Postgres, headless Chromium)', () => {
  let database: MigratedDatabase;
  let site: FakeAutomationSite;
  let storageDir: string;
  let accountId: string;
  const tokenKey = randomBytes(32);
  const vault = new SessionVault({
    vault: new LocalTokenVault(tokenKey),
    logger: createLogger({ service: 'test', level: 'silent' }),
  });
  const processes: StartedProcess[] = [];

  beforeAll(async () => {
    database = await createMigratedDatabase('runner_process', { jobQueue: true });
    site = await FakeAutomationSite.start();
    storageDir = await mkdtemp(join(tmpdir(), 'listora-runner-storage-'));
  });

  afterEach(async () => {
    for (const started of processes.splice(0)) await started.stop('SIGTERM');
    await waitFor(runnerAlive, (alive) => !alive, 'the runner to exit');
    site.clearFaults();
  });

  afterAll(async () => {
    await site.close();
    await database.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    PATH: process.env['PATH'],
    DATABASE_URL: database.scratch.url,
    FAKE_AUTOMATION_SITE_URL: site.url,
    TOKEN_ENCRYPTION_KEY: tokenKey.toString('base64'),
    STORAGE_LOCAL_DIR: storageDir,
    AI_PROVIDER: 'fake',
    LOG_LEVEL: 'info',
    // The floors: as quick as configuration allows.
    AUTOMATION_MERCARI_PACE_MS: '300-300',
    AUTOMATION_MERCARI_SESSION_GAP_MS: '2000-2000',
    RUNNER_IDLE_EXIT_SECONDS: '3',
    ...extra,
  });

  async function startWorker(): Promise<StartedProcess> {
    const worker = startNodeProcess(workerEntry, env({ BROWSER_RUNNER_LAUNCH: 'process' }));
    processes.push(worker);
    await worker.waitForLog((line) => line['msg'] === 'worker ready', 20_000);
    return worker;
  }

  // Only this test's database: a parallel test's runner (the e2e stack's) shares the cluster.
  const runnerAlive = (): Promise<boolean> => browserRunnerAlive(database.db);

  async function linkedListing() {
    accountId = await insertAccount(database.db, 'RUN');
    const item = await createInventoryItem(database.db, accountId, { title: 'Runner item' });
    const listing = await database.db
      .insertInto('marketplace_listing')
      .values({ account_id: accountId, item_id: item.id, marketplace: 'mercari' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const profile = standInProfile(automationProfile('mercari'), site.url);
    const { connectionId } = await linkAutomationSession(
      database.db,
      { vault, profile },
      // The browser runner's work: a connection whose steps run in the cloud.
      {
        accountId,
        marketplace: 'mercari',
        cookies: [site.issueSession(accountId)],
        runsOn: 'cloud',
      },
    );
    // The first sale check after linking is not part of these tests.
    await sql`delete from graphile_worker._private_jobs`.execute(database.db);
    await sql`update sale_check_schedule set next_check_at = now() + interval '1 day'`.execute(
      database.db,
    );
    return { listingId: listing.id, connectionId };
  }

  async function create(listingId: string, title: string) {
    const { operation } = await enqueueOperation(database.db, {
      accountId,
      listingId,
      kind: 'create',
      idempotencyKey: `runner-${listingId}`,
      content: withPhotosOn(site, contentWith({ title, priceCents: 4500 })),
      origin: 'user',
    });
    return operation;
  }

  const operation = (id: string) =>
    database.db
      .selectFrom('marketplace_operation')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  it('runs a handed-over step in the browser, confirms it by read-back, and exits when idle', async () => {
    const worker = await startWorker();
    const { listingId } = await linkedListing();
    const created = await create(listingId, 'Runner denim jacket');

    const done = await waitFor(
      () => operation(created.id),
      (op) =>
        op.status === 'succeeded' || op.status === 'failed' || op.status === 'needs_user_action',
      'the automated create',
      90_000,
    );
    expect(done).toMatchObject({ status: 'succeeded', success_evidence: 'read_back' });
    expect(site.listings(listingId)).toEqual([
      expect.objectContaining({ title: 'Runner denim jacket', priceCents: 4500, photoCount: 3 }),
    ]);
    const listing = await database.db
      .selectFrom('marketplace_listing')
      .select(['status', 'external_listing_id', 'remote_revision'])
      .where('id', '=', listingId)
      .executeTakeFirstOrThrow();
    expect(listing).toMatchObject({ status: 'active', remote_revision: 1 });
    expect(listing.external_listing_id).toMatch(/^L\d+$/);
    const runs = await database.db
      .selectFrom('automation_run')
      .select(['purpose', 'script', 'outcome', 'operation_id'])
      .where('account_id', '=', accountId)
      .orderBy('started_at')
      .execute();
    expect(runs.map((run) => [run.script, run.outcome, run.operation_id])).toEqual([
      ['create', 'succeeded', created.id],
      ['read listing', 'succeeded', created.id],
    ]);
    // The runner said what it was: Playwright's own headless Chromium.
    expect(site.requests.at(-1)?.userAgent).toContain('HeadlessChrome');

    await worker.waitForLog(
      (line) => line['service'] === 'runner' && line['msg'] === 'shutdown complete',
      30_000,
    );
    expect(await runnerAlive()).toBe(false);
  }, 120_000);

  it('falls back to the user and asks for a relink when the site shows a CAPTCHA', async () => {
    await startWorker();
    const { listingId, connectionId } = await linkedListing();
    site.inject({ action: 'search', fault: { type: 'captcha' } });
    const created = await create(listingId, 'Challenged jacket');

    const done = await waitFor(
      () => operation(created.id),
      (op) => op.status !== 'queued' && op.status !== 'running' && op.status !== 'retrying',
      'the challenged create',
      90_000,
    );
    expect(done.status).toBe('needs_user_action');
    const tasks = await database.db
      .selectFrom('user_task')
      .select(['kind', 'status', 'operation_id'])
      .where('account_id', '=', accountId)
      .orderBy('kind')
      .execute();
    expect(tasks).toEqual([
      { kind: 'list_manually', status: 'open', operation_id: created.id },
      { kind: 'reconnect', status: 'open', operation_id: null },
    ]);
    const connection = await database.db
      .selectFrom('marketplace_connection')
      .select(['status', 'token_ciphertext'])
      .where('id', '=', connectionId)
      .executeTakeFirstOrThrow();
    expect(connection).toEqual({ status: 'reauth_required', token_ciphertext: null });
    expect(site.listings(listingId)).toEqual([]);
  }, 120_000);

  it("checks the seller's sales when asked, for the sale intake", async () => {
    await startWorker();
    const { listingId } = await linkedListing();
    const id = site.seed({
      seller: accountId,
      sku: listingId,
      title: 'Sold jacket',
      description: 'Blue.',
      priceCents: 3200,
    });
    const order = site.sell(id);
    expect(await requestSaleCheck(database.db, { accountId, marketplace: 'mercari' })).toBe(true);

    const events = await waitFor(
      () =>
        database.db
          .selectFrom('inbound_event')
          .select(['source', 'provider_event_id'])
          .where('account_id', '=', accountId)
          .execute(),
      (rows) => rows.length > 0,
      'the sale check',
      90_000,
    );
    expect(events).toEqual([{ source: 'poll', provider_event_id: `order:${order.id}` }]);
  }, 120_000);

  it('passes its browser self-test', async () => {
    const selfTest = startNodeProcess(runnerEntry, { PATH: process.env['PATH'] }, ['self-test']);
    expect(await selfTest.waitForExit(60_000)).toBe(0);
    expect(selfTest.logs.at(-1)).toMatchObject({ msg: 'browser self-test passed' });
  }, 90_000);
});

/** The content's photos, served by the fake site in place of Listora's image CDN. */
function withPhotosOn(site: FakeAutomationSite, content: ListingContent): ListingContent {
  return {
    ...content,
    item: {
      ...content.item,
      photos: content.item.photos.map((photo) => ({
        ...photo,
        url: `${site.url}/photos/${photo.photoId}.jpg`,
      })),
    },
  };
}

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

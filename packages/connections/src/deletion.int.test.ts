import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInventoryItem, jsonb, type Marketplace } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import { createLogger } from '@listora/shared';
import { LocalDiskStorage, type ObjectStorage } from '@listora/storage';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  completeConnectionDeletion,
  CONNECTION_DELETION_TASK,
  connectionDeletionTask,
  startConnectionDeletion,
  type ConnectionDeletionDependencies,
  type GrantRevoker,
} from './deletion.ts';
import type { GrantTokens } from './revoker.ts';

/** Answers each revocation as told (confirmed by default) and records every request. */
class FakeRevoker implements GrantRevoker {
  readonly asked: GrantTokens[] = [];
  answer: boolean | Error = true;

  revoke(grant: GrantTokens): Promise<boolean> {
    this.asked.push(grant);
    return this.answer instanceof Error
      ? Promise.reject(this.answer)
      : Promise.resolve(this.answer);
  }
}

describe('connection deletion (real Postgres)', () => {
  let database: MigratedDatabase;
  let storageDir: string;
  let storage: LocalDiskStorage;

  beforeAll(async () => {
    database = await createMigratedDatabase('connection_deletion', { jobQueue: true });
    storageDir = await mkdtemp(join(tmpdir(), 'listora-connection-deletion-'));
    storage = new LocalDiskStorage({
      rootDir: storageDir,
      baseUrl: 'http://127.0.0.1:3000',
      signingSecret: 'connection-deletion-test-secret-0123456789',
    });
  });

  afterAll(async () => {
    await database.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  interface Harness extends ConnectionDeletionDependencies {
    revoker: FakeRevoker;
    logs: Record<string, unknown>[];
  }

  function harness(overrides: Partial<ConnectionDeletionDependencies> = {}): Harness {
    const logs: Record<string, unknown>[] = [];
    return {
      db: database.db,
      revoker: new FakeRevoker(),
      storage,
      logger: createLogger({
        service: 'connection-deletion-test',
        level: 'info',
        destination: {
          write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>),
        },
      }),
      logs,
      ...overrides,
    } as Harness;
  }

  /** A seller's connection, with a listing read back through it and an event about them. */
  async function seed(input: {
    marketplace: Marketplace;
    mode: 'api' | 'automation';
    screenshots?: number;
  }) {
    const accountId = await insertAccount(database.db);
    const sellerId = `seller-${randomUUID()}`;
    const connection = await database.db
      .insertInto('marketplace_connection')
      .values({
        account_id: accountId,
        marketplace: input.marketplace,
        mode: input.mode,
        external_user_id: input.mode === 'api' ? sellerId : null,
        display_name: 'closet_queen',
        token_ciphertext: Buffer.from(input.mode === 'api' ? 'sealed tokens' : 'sealed session'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const item = await createInventoryItem(database.db, accountId);
    const listing = await database.db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId,
        item_id: item.id,
        marketplace: input.marketplace,
        connection_id: connection.id,
        status: 'active',
        external_listing_id: `listing-${randomUUID()}`,
        remote_snapshot: jsonb({ title: 'Wool coat', seller: sellerId }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const other of [sellerId, `other-${randomUUID()}`]) {
      await database.db
        .insertInto('inbound_event')
        .values({
          account_id: accountId,
          source: 'poll',
          marketplace: input.marketplace,
          provider_event_id: randomUUID(),
          payload: jsonb({ seller: other }),
          external_user_id: input.mode === 'api' ? other : null,
        })
        .execute();
    }
    const screenshotKeys: string[] = [];
    for (let run = 0; run < (input.screenshots ?? 0); run += 1) {
      const key = `automation/${accountId}/${randomUUID()}.png`;
      await storage.put(key, new Uint8Array([137, 80, 78, 71]), { contentType: 'image/png' });
      await database.db
        .insertInto('automation_run')
        .values({
          account_id: accountId,
          connection_id: connection.id,
          marketplace: input.marketplace,
          purpose: 'health',
          script: 'health check',
          finished_at: new Date(),
          outcome: 'failed',
          failed_step: 'open the closet',
          screenshot_key: key,
        })
        .execute();
      screenshotKeys.push(key);
    }
    return {
      accountId,
      connectionId: connection.id,
      listingId: listing.id,
      sellerId,
      screenshotKeys,
    };
  }

  async function start(seeded: { accountId: string; connectionId: string }) {
    const started = await database.db
      .transaction()
      .execute((trx) => startConnectionDeletion(trx, { ...seeded, reason: 'unlinked' }));
    if (started === undefined) throw new Error('nothing deleted');
    return started;
  }

  function tombstone(deletionId: string) {
    return database.db
      .selectFrom('connection_deletion')
      .selectAll()
      .where('id', '=', deletionId)
      .executeTakeFirst();
  }

  function record(deletionId: string) {
    return database.db
      .selectFrom('deletion_record')
      .selectAll()
      .where('id', '=', deletionId)
      .executeTakeFirst();
  }

  async function jobRunAt(deletionId: string): Promise<Date | undefined> {
    const { rows } = await sql<{ run_at: Date }>`
      select run_at from graphile_worker.jobs
      where task_identifier = ${CONNECTION_DELETION_TASK}
        and key = ${`connection_deletion:${deletionId}`}
    `.execute(database.db);
    return rows[0]?.run_at;
  }

  async function stored(keys: readonly string[]): Promise<string[]> {
    const found: string[] = [];
    for (const key of keys) if (await storage.head(key)) found.push(key);
    return found;
  }

  it('deletes an OAuth connection and its marketplace data at once, then revokes and records it', async () => {
    const seeded = await seed({ marketplace: 'ebay', mode: 'api' });
    const started = await start(seeded);
    expect(started.deleted).toMatchObject({
      marketplace: 'ebay',
      listings: 1,
      inboundEvents: 1,
      automationRuns: 0,
    });

    const { db } = database;
    const connections = await db
      .selectFrom('marketplace_connection')
      .select('id')
      .where('id', '=', seeded.connectionId)
      .execute();
    expect(connections).toEqual([]);
    // The listing stays the seller's record, without the marketplace's read-back.
    const listing = await db
      .selectFrom('marketplace_listing')
      .select(['connection_id', 'remote_snapshot', 'status'])
      .where('id', '=', seeded.listingId)
      .executeTakeFirstOrThrow();
    expect(listing).toEqual({ connection_id: null, remote_snapshot: null, status: 'active' });
    const events = await db
      .selectFrom('inbound_event')
      .select('external_user_id')
      .where('account_id', '=', seeded.accountId)
      .execute();
    expect(events.map((event) => event.external_user_id)).not.toContain(seeded.sellerId);
    expect(events).toHaveLength(1);
    // Only the tokens are kept, for the revocation, and only in the tombstone.
    expect(await tombstone(started.deletionId)).toMatchObject({
      connection_id: seeded.connectionId,
      marketplace: 'ebay',
      reason: 'unlinked',
      revocation: 'pending',
      token_ciphertext: Buffer.from('sealed tokens'),
    });
    expect(await jobRunAt(started.deletionId)).toBeDefined();

    const deps = harness();
    expect(await completeConnectionDeletion(deps, started.deletionId)).toBe('completed');
    expect(deps.revoker.asked).toEqual([
      {
        connectionId: seeded.connectionId,
        marketplace: 'ebay',
        tokenCiphertext: Buffer.from('sealed tokens'),
      },
    ]);
    expect(await tombstone(started.deletionId)).toBeUndefined();
    const completed = await record(started.deletionId);
    expect(completed).toMatchObject({
      kind: 'connection',
      reason: 'unlinked',
      marketplace: 'ebay',
      summary: { revocation: 'revoked', verified: { rows: 0, objects: 0 }, attempts: 1 },
    });
    expect(JSON.stringify(completed)).not.toContain(seeded.sellerId);
    expect(JSON.stringify(completed)).not.toContain(seeded.accountId);
    expect(await completeConnectionDeletion(deps, started.deletionId)).toBe('not_found');
  });

  it('deletes a browser session connection with its runs and their screenshots', async () => {
    const seeded = await seed({ marketplace: 'poshmark', mode: 'automation', screenshots: 2 });
    const started = await start(seeded);
    expect(started.deleted).toMatchObject({ automationRuns: 2, grantCiphertext: null });
    const runs = await database.db
      .selectFrom('automation_run')
      .select('id')
      .where('connection_id', '=', seeded.connectionId)
      .execute();
    expect(runs).toEqual([]);
    // A session is not a grant: there is nothing to revoke, and nothing is kept.
    expect(await tombstone(started.deletionId)).toMatchObject({
      revocation: 'none',
      token_ciphertext: null,
    });
    expect(await stored(seeded.screenshotKeys)).toHaveLength(2);

    const deps = harness();
    expect(await completeConnectionDeletion(deps, started.deletionId)).toBe('completed');
    expect(deps.revoker.asked).toEqual([]);
    expect(await stored(seeded.screenshotKeys)).toEqual([]);
    expect(await record(started.deletionId)).toMatchObject({
      marketplace: 'poshmark',
      summary: { revocation: 'none' },
    });
  });

  it('keeps asking the marketplace to revoke, and gives up as manual when the window ends', async () => {
    const seeded = await seed({ marketplace: 'ebay', mode: 'api' });
    const started = await start(seeded);
    const deps = harness();
    deps.revoker.answer = new Error('eBay is down');

    expect(await completeConnectionDeletion(deps, started.deletionId)).toBe('retrying');
    expect(await tombstone(started.deletionId)).toMatchObject({
      revocation: 'pending',
      attempts: 1,
    });
    expect((await jobRunAt(started.deletionId))?.getTime()).toBeGreaterThan(Date.now() + 50_000);

    const requestedAt = (await tombstone(started.deletionId))?.requested_at.getTime() ?? 0;
    const late = harness({ now: () => requestedAt + 7 * 86_400_000 });
    late.revoker.answer = false;
    expect(await completeConnectionDeletion(late, started.deletionId)).toBe('completed');
    expect(await record(started.deletionId)).toMatchObject({ summary: { revocation: 'manual' } });
    expect(late.logs).toContainEqual(
      expect.objectContaining({
        msg: 'gave up revoking marketplace access of a deleted connection; the seller must',
      }),
    );
  });

  it('stays open while storage fails, overdue past the deadline, and finishes when it recovers', async () => {
    const seeded = await seed({ marketplace: 'mercari', mode: 'automation', screenshots: 1 });
    const started = await start(seeded);
    const failing: ObjectStorage = {
      driver: 'local',
      createUploadTarget: (request) => storage.createUploadTarget(request),
      head: (key) => storage.head(key),
      get: (key) => storage.get(key),
      put: (key, body, options) => storage.put(key, body, options),
      list: (prefix, limit) => storage.list(prefix, limit),
      publicUrl: (key) => storage.publicUrl(key),
      delete: () => Promise.reject(new Error('SlowDown')),
    };
    const deps = harness({ storage: failing, now: () => Date.now() + 9 * 86_400_000 });
    expect(await completeConnectionDeletion(deps, started.deletionId)).toBe('retrying');
    expect(await record(started.deletionId)).toBeUndefined();
    expect(deps.logs).toContainEqual(
      expect.objectContaining({
        level: 50,
        event: 'connection_deletion_overdue',
        objectsDeleted: false,
      }),
    );

    expect(await completeConnectionDeletion(harness(), started.deletionId)).toBe('completed');
    expect(await stored(seeded.screenshotKeys)).toEqual([]);
  });

  it("finds nothing to delete for another account's connection", async () => {
    const seeded = await seed({ marketplace: 'ebay', mode: 'api' });
    const otherAccount = await insertAccount(database.db);
    const started = await database.db.transaction().execute((trx) =>
      startConnectionDeletion(trx, {
        accountId: otherAccount,
        connectionId: seeded.connectionId,
        reason: 'unlinked',
      }),
    );
    expect(started).toBeUndefined();
    const connection = await database.db
      .selectFrom('marketplace_connection')
      .select('id')
      .where('id', '=', seeded.connectionId)
      .executeTakeFirst();
    expect(connection).toBeDefined();
  });

  it('runs as a Graphile task, and drops a job with an invalid payload', async () => {
    const seeded = await seed({ marketplace: 'ebay', mode: 'api' });
    const started = await start(seeded);
    const deps = harness();
    await connectionDeletionTask(deps)({ deletionId: started.deletionId });
    expect(await tombstone(started.deletionId)).toBeUndefined();

    await connectionDeletionTask(deps)({ connectionId: 'x' });
    expect(deps.logs).toContainEqual(
      expect.objectContaining({
        msg: 'connection deletion job with an invalid payload; dropping it',
      }),
    );
  });
});

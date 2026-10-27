import { createHash, randomUUID } from 'node:crypto';

import { lockIdentity, rememberDeletedIdentity } from '@listora/accounts';
import { jsonb, type Db, type Marketplace } from '@listora/db';
import { sql } from 'kysely';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { photoObjectKeys } from '../photos/stored-objects.ts';
import { createTestApi, type TestApi } from '../test-support.ts';
import { resolveTenant, type Tenant } from '../tenancy.ts';

/**
 * Every table with an `account_id`, so a test can prove an account left nothing behind. The
 * deletion's own tombstone names the account until its job checks the same thing.
 */
async function tenantTables(db: Db): Promise<string[]> {
  const { rows } = await sql<{ table_name: string }>`
    select c.table_name from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.column_name = 'account_id'
      and t.table_type = 'BASE TABLE' and c.table_name <> 'account_deletion'
    order by c.table_name
  `.execute(db);
  return rows.map((row) => row.table_name);
}

/** Rows per tenant table that belong to `accountId`, leaving out tables with none. */
async function rowsOf(db: Db, accountId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of await tenantTables(db)) {
    const { rows } = await sql<{ count: string }>`
      select count(*) as count from ${sql.table(table)} where account_id = ${accountId}
    `.execute(db);
    const count = Number(rows[0]?.count ?? 0);
    if (count > 0) counts[table] = count;
  }
  return counts;
}

async function userCount(db: Db, subject: string): Promise<number> {
  const rows = await db
    .selectFrom('app_user')
    .select('id')
    .where('auth_subject', '=', subject)
    .execute();
  return rows.length;
}

async function tombstones(db: Db) {
  return db.selectFrom('account_deletion').selectAll().execute();
}

interface GrantRow {
  connection_id: string;
  outcome: string;
  token: string | null;
}

/** Every kept marketplace grant, with its token as text. */
async function grantsOf(db: Db): Promise<GrantRow[]> {
  const rows = await db
    .selectFrom('account_deletion_grant')
    .select(['connection_id', 'outcome', 'token_ciphertext'])
    .orderBy('connection_id')
    .execute();
  return rows.map((row) => ({
    connection_id: row.connection_id,
    outcome: row.outcome,
    token: row.token_ciphertext?.toString() ?? null,
  }));
}

function byConnection(a: GrantRow, b: GrantRow): number {
  return a.connection_id.localeCompare(b.connection_id);
}

/** The keys of every stored object the account's photos and uploads reference. */
async function objectKeysOf(db: Db, accountId: string): Promise<string[]> {
  const photos = await db
    .selectFrom('photo')
    .selectAll()
    .where('account_id', '=', accountId)
    .execute();
  const uploads = await db
    .selectFrom('upload_file')
    .select('storage_key')
    .where('account_id', '=', accountId)
    .execute();
  const runs = await db
    .selectFrom('automation_run')
    .select('screenshot_key')
    .where('account_id', '=', accountId)
    .execute();
  return [
    ...photos.flatMap(photoObjectKeys),
    ...uploads.map((upload) => upload.storage_key),
    ...runs.flatMap((run) => (run.screenshot_key === null ? [] : [run.screenshot_key])),
  ];
}

interface ConnectionSeed {
  marketplace: Marketplace;
  mode?: 'api' | 'assisted';
  token?: boolean;
  status?: 'connected' | 'revoked';
  displayName?: string;
}

describe('deleteAccount (real Postgres)', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await createTestApi('account');
  });

  afterAll(async () => {
    await api.close();
  });

  async function addConnection(tenant: Tenant, seed: ConnectionSeed): Promise<string> {
    const mode = seed.mode ?? 'api';
    const row = await api.db
      .insertInto('marketplace_connection')
      .values({
        account_id: tenant.accountId,
        marketplace: seed.marketplace,
        mode,
        external_user_id: mode === 'api' ? `${seed.marketplace}-${randomUUID()}` : null,
        display_name: seed.displayName ?? null,
        token_ciphertext: seed.token === false || mode === 'assisted' ? null : Buffer.from('ct'),
        status: seed.status ?? 'connected',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** An account with a bit of everything: items, photos, listings, history, and AI usage. */
  async function populate(token: string, tenant: Tenant): Promise<void> {
    const item = (await api.call('createItem', { token, body: { details: { title: 'Coat' } } }))
      .body;
    const bytes = await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#7a6a5a' },
    })
      .jpeg()
      .toBuffer();
    const uploadFileId = await api.uploads.add(tenant, { bytes: new Uint8Array(bytes) });
    expect(
      (
        await api.call('addItemPhoto', {
          token,
          params: { itemId: item.id },
          body: { uploadFileId, role: 'front', width: 64, height: 48 },
        })
      ).status,
    ).toBe(201);
    await api.photoJobs.runAll();
    // An upload no photo uses yet.
    await api.uploads.add(tenant);
    const connectionId = await addConnection(tenant, { marketplace: 'ebay' });
    // A browser automation connection, and the screenshot of one of its failed runs.
    const automation = await api.db
      .insertInto('marketplace_connection')
      .values({
        account_id: tenant.accountId,
        marketplace: 'mercari',
        mode: 'automation',
        token_ciphertext: Buffer.from('sealed session'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const screenshotKey = `automation/${tenant.accountId}/run-1.png`;
    await api.storage.put(screenshotKey, new Uint8Array([137, 80, 78, 71]), {
      contentType: 'image/png',
    });
    await api.db
      .insertInto('automation_run')
      .values({
        account_id: tenant.accountId,
        connection_id: automation.id,
        marketplace: 'mercari',
        purpose: 'health',
        script: 'health check',
        finished_at: new Date(),
        outcome: 'failed',
        failed_step: 'open the account',
        screenshot_key: screenshotKey,
      })
      .execute();
    const listing = await api.db
      .insertInto('marketplace_listing')
      .values({
        account_id: tenant.accountId,
        item_id: item.id,
        marketplace: 'ebay',
        connection_id: connectionId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const operation = await api.db
      .insertInto('marketplace_operation')
      .values({
        account_id: tenant.accountId,
        listing_id: listing.id,
        kind: 'create',
        idempotency_key: `create-${listing.id}`,
        desired: jsonb({ priceCents: 4500 }),
        content: jsonb({ variant: { title: 'Jacket' } }),
        origin: 'user',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await api.db
      .insertInto('operation_event')
      .values({ account_id: tenant.accountId, operation_id: operation.id, to_status: 'queued' })
      .execute();
    await api.db
      .insertInto('ai_usage_event')
      .values({
        account_id: tenant.accountId,
        user_id: tenant.userId,
        item_id: item.id,
        purpose: 'item_analysis',
        provider: 'fake',
        model: 'claude-haiku-5-5',
        tier: 'standard',
        outcome: 'succeeded',
        cost_micros: 1500,
        price_table_version: 'test',
      })
      .execute();
  }

  it('deletes the account, all of its data, and the user, and leaves other accounts alone', async () => {
    const owner = 'olivia.owner@example.com';
    const neighbor = 'nina.neighbor@example.com';
    const token = await api.signIn(owner);
    const tenant = await api.tenantOf(owner);
    const neighborToken = await api.signIn(neighbor);
    const neighborTenant = await api.tenantOf(neighbor);
    await populate(token, tenant);
    await populate(neighborToken, neighborTenant);
    const neighborRows = await rowsOf(api.db, neighborTenant.accountId);
    const keys = await objectKeysOf(api.db, tenant.accountId);
    const neighborKeys = await objectKeysOf(api.db, neighborTenant.accountId);
    // The processed photo's four derived images, the unattached upload (processing already
    // deleted the photo's own upload), and the automation screenshot.
    const stored = async (list: string[]) =>
      (
        await Promise.all(list.map(async (key) => ((await api.storage.head(key)) ? key : null)))
      ).filter((key) => key !== null);
    expect(await stored(keys)).toHaveLength(6);
    const neighborStored = await stored(neighborKeys);
    expect(neighborStored).toHaveLength(6);
    expect(Object.keys(await rowsOf(api.db, tenant.accountId))).toEqual(
      expect.arrayContaining([
        'audit_log',
        'automation_run',
        'ai_usage_event',
        'ai_usage_daily',
        'idempotency_record',
        'inventory_item',
        'marketplace_connection',
        'marketplace_listing',
        'marketplace_operation',
        'membership',
        'operation_event',
        'photo',
        'sku_sequence',
        'upload_file',
        'upload_session',
      ]),
    );

    const response = await api.call('deleteAccount', { token });
    expect(response.status).toBe(200);
    expect(Date.parse(response.body.deletedAt)).toBeGreaterThan(Date.now() - 60_000);
    // Asking eBay is the job's work, so the revocation is not confirmed yet.
    expect(response.body.marketplaceAccess).toEqual([{ marketplace: 'ebay', revoked: false }]);

    expect(await rowsOf(api.db, tenant.accountId)).toEqual({});
    const account = await api.db
      .selectFrom('account')
      .select('id')
      .where('id', '=', tenant.accountId)
      .execute();
    expect(account).toEqual([]);
    expect(await userCount(api.db, owner)).toBe(0);
    expect(await stored(keys)).toEqual([]);
    expect(await stored(neighborKeys)).toEqual(neighborStored);
    expect(await rowsOf(api.db, neighborTenant.accountId)).toEqual(neighborRows);
    expect((await api.call('listItems', { token: neighborToken })).body.data).toHaveLength(1);

    // The job finishes the deletion: the grant is revoked, and the tombstone is gone.
    expect(await api.accountDeletions.jobs()).toHaveLength(1);
    expect(await api.accountDeletions.runAll()).toEqual(['completed']);
    expect(
      api.accountDeletions.marketplaceAccess.revoked.map((grant) => grant.marketplace),
    ).toEqual(['ebay']);
    expect(await tombstones(api.db)).toEqual([]);
    expect(await api.accountDeletions.jobs()).toEqual([]);
    // What is left is the checked completion record, which names no one.
    const record = await api.db
      .selectFrom('deletion_record')
      .selectAll()
      .where('kind', '=', 'account')
      .orderBy('completed_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(record.summary).toMatchObject({
      accountDeleted: true,
      revoked: ['ebay'],
      verified: { rows: 0, objects: 0 },
    });
    expect(JSON.stringify(record)).not.toContain(tenant.accountId);
  });

  it('ends every session issued before the deletion without provisioning a new account', async () => {
    const email = 'sam.sessions@example.com';
    const first = await api.signIn(email);
    const second = await api.signIn(email);
    expect((await api.call('deleteAccount', { token: first })).status).toBe(200);

    for (const token of [first, second]) {
      const listed = await api.call('listItems', { token });
      expect(listed.status).toBe(401);
      expect(listed.error.code).toBe('unauthenticated');
      // A retry after a lost success response reads as signed out, not as a new deletion.
      expect((await api.call('deleteAccount', { token })).status).toBe(401);
    }
    expect(await userCount(api.db, email)).toBe(0);
    expect(await api.accountDeletions.runAll()).toEqual(['completed']);
  });

  it('lets the person sign up again later, into a new empty account', async () => {
    const email = 'rita.returns@example.com';
    const token = await api.signIn(email);
    const before = await api.tenantOf(email);
    await api.call('createItem', { token, body: {} });
    expect((await api.call('deleteAccount', { token })).status).toBe(200);

    api.clock.now = Date.now() + 2000;
    try {
      // A dev identity has nothing to delete at a provider, so this needs no worker.
      const again = await api.signIn(email);
      const items = await api.call('listItems', { token: again });
      expect(items.status).toBe(200);
      expect(items.body.data).toEqual([]);
      const after = await api.tenantOf(email);
      expect(after.accountId).not.toBe(before.accountId);
      expect(after.userId).not.toBe(before.userId);
      expect(await api.accountDeletions.runAll()).toEqual(['completed']);
    } finally {
      api.clock.now = Date.now();
    }
  });

  it('remembers the deleted identity only as a hash, and purges expired entries', async () => {
    const email = 'harry.hash@example.com';
    const stale = { auth_provider: 'dev' as const, auth_subject_sha256: sha256('stale') };
    const recent = { auth_provider: 'dev' as const, auth_subject_sha256: sha256('recent') };
    await api.db
      .insertInto('deleted_identity')
      .values([
        { ...stale, deleted_at: new Date(Date.now() - 49 * 3_600_000) },
        { ...recent, deleted_at: new Date(Date.now() - 47 * 3_600_000) },
      ])
      .execute();
    const token = await api.signIn(email);
    expect((await api.call('deleteAccount', { token })).status).toBe(200);

    const rows = await api.db
      .selectFrom('deleted_identity')
      .select(['auth_provider', 'auth_subject_sha256'])
      .execute();
    const hashes = rows.map((row) => row.auth_subject_sha256.toString('hex'));
    expect(hashes).toContain(sha256(email).toString('hex'));
    expect(hashes).toContain(recent.auth_subject_sha256.toString('hex'));
    expect(hashes).not.toContain(stale.auth_subject_sha256.toString('hex'));
    const { rows: plain } = await sql<{ found: boolean }>`
      select exists (
        select 1 from deleted_identity where position(${email}::bytea in auth_subject_sha256) > 0
      ) as found
    `.execute(api.db);
    expect(plain[0]?.found).toBe(false);
    // The tombstone keeps the same hash, and no username for a dev identity.
    expect(
      (await tombstones(api.db)).filter((row) => row.auth_subject_sha256.equals(sha256(email))),
    ).toEqual([expect.objectContaining({ auth_provider: 'dev', provider_username: null })]);
    await api.accountDeletions.runAll();
  });

  it('refuses to provision a user while a deletion of the identity is committing', async () => {
    const email = 'rory.race@example.com';
    const identity = {
      provider: 'dev' as const,
      subject: email,
      issuedAt: Math.floor(Date.now() / 1000) - 1,
    };
    // A deletion holds the identity's lock; a request with an earlier token arrives and
    // finds no user, so it would provision one.
    const deletion = await api.db.startTransaction().execute();
    let provisioned: Promise<Tenant> | undefined;
    try {
      await lockIdentity(deletion, identity);
      provisioned = resolveTenant(api.db, identity, { mode: 'open' });
      provisioned.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await userCount(api.db, email)).toBe(0);
      await rememberDeletedIdentity(deletion, 'dev', sha256(email));
      await deletion.commit().execute();
    } catch (error) {
      await deletion.rollback().execute();
      throw error;
    }
    await expect(provisioned).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(await userCount(api.db, email)).toBe(0);
  });

  describe('marketplace access', () => {
    it('reports only confirmed revocations, and keeps revoking until confirmed or given up', async () => {
      const email = 'mia.markets@example.com';
      const token = await api.signIn(email);
      const tenant = await api.tenantOf(email);
      const confirmed = await addConnection(tenant, { marketplace: 'ebay', displayName: 'mia_e' });
      const unconfirmed = await addConnection(tenant, { marketplace: 'depop' });
      const failing = await addConnection(tenant, {
        marketplace: 'ebay',
        displayName: 'mia_shop2',
      });
      const alreadyRevoked = await addConnection(tenant, {
        marketplace: 'depop',
        displayName: 'mia_old',
        status: 'revoked',
        token: false,
      });
      const tokenless = await addConnection(tenant, { marketplace: 'ebay', token: false });
      await addConnection(tenant, { marketplace: 'poshmark', mode: 'assisted' });
      const { marketplaceAccess } = api.accountDeletions;
      marketplaceAccess.answer(unconfirmed, false);
      marketplaceAccess.answer(failing, new Error('eBay is down'));

      const response = await api.call('deleteAccount', { token });
      expect(response.status).toBe(200);
      const byId = new Map(
        [confirmed, unconfirmed, failing, alreadyRevoked, tokenless].map((id, index) => [
          id,
          response.body.marketplaceAccess[index],
        ]),
      );
      expect(response.body.marketplaceAccess).toHaveLength(5);
      // Only the revocation the marketplace confirmed before the deletion is reported as done.
      expect(byId.get(confirmed)).toEqual({
        marketplace: 'ebay',
        displayName: 'mia_e',
        revoked: false,
      });
      expect(byId.get(unconfirmed)).toEqual({ marketplace: 'depop', revoked: false });
      expect(byId.get(alreadyRevoked)).toEqual({
        marketplace: 'depop',
        displayName: 'mia_old',
        revoked: true,
      });
      // Listora lost the tokens, so it cannot claim the marketplace revoked them.
      expect(byId.get(tokenless)).toEqual({ marketplace: 'ebay', revoked: false });
      expect(await rowsOf(api.db, tenant.accountId)).toEqual({});
      // The tombstone keeps the encrypted tokens of the grants still to revoke, and only those.
      expect(await grantsOf(api.db)).toEqual(
        [
          { connection_id: confirmed, outcome: 'pending', token: 'ct' },
          { connection_id: unconfirmed, outcome: 'pending', token: 'ct' },
          { connection_id: failing, outcome: 'pending', token: 'ct' },
        ].sort(byConnection),
      );

      expect(await api.accountDeletions.runAll()).toEqual(['retrying']);
      const asked = () =>
        marketplaceAccess.revoked
          .filter((grant) => [confirmed, unconfirmed, failing].includes(grant.connectionId))
          .map((grant) => grant.connectionId);
      expect(asked().sort()).toEqual([confirmed, unconfirmed, failing].sort());
      expect(
        marketplaceAccess.revoked.some((grant) =>
          [alreadyRevoked, tokenless].includes(grant.connectionId),
        ),
      ).toBe(false);
      expect(await grantsOf(api.db)).toEqual(
        [
          { connection_id: confirmed, outcome: 'revoked', token: null },
          { connection_id: unconfirmed, outcome: 'pending', token: 'ct' },
          { connection_id: failing, outcome: 'pending', token: 'ct' },
        ].sort(byConnection),
      );

      // A later run asks again for the unconfirmed ones only.
      marketplaceAccess.answer(unconfirmed, true);
      expect(await api.accountDeletions.runAll()).toEqual(['retrying']);
      expect(asked().filter((id) => id === confirmed)).toHaveLength(1);
      expect(asked().filter((id) => id === unconfirmed)).toHaveLength(2);

      // After the revocation window, the job gives up: the tokens are deleted, and the
      // tombstone goes.
      await sql`update account_deletion set requested_at = now() - interval '8 days'`.execute(
        api.db,
      );
      expect(await api.accountDeletions.runAll()).toEqual(['completed']);
      expect(asked().filter((id) => id === failing)).toHaveLength(3);
      expect(await grantsOf(api.db)).toEqual([]);
      expect(await tombstones(api.db)).toEqual([]);
    });
  });

  describe('failures stay retryable', () => {
    it('deletes nothing when the database fails, and finishes on retry', async () => {
      const email = 'dana.database@example.com';
      const token = await api.signIn(email);
      const tenant = await api.tenantOf(email);
      await populate(token, tenant);
      const rows = await rowsOf(api.db, tenant.accountId);
      await sql`
        create function test_fail_deletion() returns trigger language plpgsql as $$
        begin
          raise exception 'simulated database failure';
        end;
        $$;
        create trigger test_fail_deletion before delete on app_user
          for each row execute function test_fail_deletion();
      `.execute(api.db);
      try {
        const failed = await api.call('deleteAccount', { token });
        expect(failed.status).toBe(500);
        expect(failed.error.retryable).toBe(true);
        // The transaction rolled back as a whole: no data is gone, the identity is not
        // marked deleted, and no tombstone or job was left.
        expect(await userCount(api.db, email)).toBe(1);
        expect(await rowsOf(api.db, tenant.accountId)).toEqual(rows);
        expect(await tombstones(api.db)).toEqual([]);
        expect(await api.accountDeletions.jobs()).toEqual([]);
        expect((await api.call('listItems', { token })).status).toBe(200);
      } finally {
        await sql`
          drop trigger test_fail_deletion on app_user;
          drop function test_fail_deletion();
        `.execute(api.db);
      }
      expect((await api.call('deleteAccount', { token })).status).toBe(200);
      expect(await userCount(api.db, email)).toBe(0);
      expect(await rowsOf(api.db, tenant.accountId)).toEqual({});
      expect(await api.accountDeletions.runAll()).toEqual(['completed']);
    });

    it('answers 401 to a second deletion that waited for the first', async () => {
      const email = 'tess.twice@example.com';
      const token = await api.signIn(email);
      await api.tenantOf(email);
      const [first, second] = await Promise.all([
        api.call('deleteAccount', { token }),
        api.call('deleteAccount', { token }),
      ]);
      expect([first.status, second.status].sort()).toEqual([200, 401]);
      expect(await api.accountDeletions.jobs()).toHaveLength(1);
      expect(await api.accountDeletions.runAll()).toEqual(['completed']);
    });
  });

  describe('accounts with other members', () => {
    it('refuses the owner, and deletes a member without touching the account', async () => {
      const ownerEmail = 'oscar.owner@example.com';
      const memberEmail = 'molly.member@example.com';
      const ownerToken = await api.signIn(ownerEmail);
      const owner = await api.tenantOf(ownerEmail);
      await populate(ownerToken, owner);
      // Members cannot be invited through the API yet, so the test adds one directly.
      const member = await api.db
        .insertInto('app_user')
        .values({ auth_provider: 'dev', auth_subject: memberEmail, email: memberEmail })
        .returning('id')
        .executeTakeFirstOrThrow();
      await api.db
        .insertInto('membership')
        .values({ account_id: owner.accountId, user_id: member.id, role: 'member' })
        .execute();
      await api.db
        .insertInto('ai_usage_event')
        .values({
          account_id: owner.accountId,
          user_id: member.id,
          purpose: 'item_analysis',
          provider: 'fake',
          model: 'claude-haiku-5-5',
          tier: 'standard',
          outcome: 'succeeded',
          cost_micros: 900,
          price_table_version: 'test',
        })
        .execute();
      const memberToken = await api.signIn(memberEmail);
      const rows = await rowsOf(api.db, owner.accountId);

      const refused = await api.call('deleteAccount', { token: ownerToken });
      expect(refused.status).toBe(403);
      expect(refused.error.code).toBe('forbidden');
      expect(await rowsOf(api.db, owner.accountId)).toEqual(rows);

      const left = await api.call('deleteAccount', { token: memberToken });
      expect(left.status).toBe(200);
      expect(left.body.marketplaceAccess).toEqual([]);
      expect(await userCount(api.db, memberEmail)).toBe(0);
      // The account keeps its data; the member's AI usage stays without the reference.
      expect(await rowsOf(api.db, owner.accountId)).toEqual({ ...rows, membership: 1 });
      const usage = await api.db
        .selectFrom('ai_usage_event')
        .select('user_id')
        .where('account_id', '=', owner.accountId)
        .where('cost_micros', '=', 900)
        .execute();
      expect(usage).toEqual([{ user_id: null }]);
      // The member's marketplace grants belong to the account, so none were revoked.
      expect((await api.call('listItems', { token: ownerToken })).status).toBe(200);

      // With the member gone, the owner can delete the account.
      expect((await api.call('deleteAccount', { token: ownerToken })).status).toBe(200);
      expect(await rowsOf(api.db, owner.accountId)).toEqual({});
      expect(await api.accountDeletions.runAll()).toEqual(['completed', 'completed']);
    });
  });
});

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

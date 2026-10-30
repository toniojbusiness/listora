import { sql } from 'kysely';
import type { MigrationProvider } from 'kysely/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Db, SchemaMigrator, SqlFileMigrationProvider } from '@listora/db';
import { insertAccount } from '@listora/db/testing';
import { createScratchDatabase, type ScratchDatabase } from '@listora/testing';

import { ProtectedShopError, setConnectionReadOnly } from './read-only.ts';

/** The migration under test (docs/features/read-only.md#one-off-the-live-depop-shop). */
const MIGRATION = '20261030173934_live_shop_unprotected';
/** The live shop's seller digest, the only way the repository names it. */
const LIVE_SHOP_DIGEST = 'aad3b2ee04d134389b11cda5acb004bc341b2fa44bae5ad650d74d93426ee1f5';
/** An invented seller that stands in for the live shop: `seller_digest` gives it its digest. */
const LIVE_SHOP = 'formerly-protected-shop';

/** Every shipped migration but the one under test. */
const withoutMigration: MigrationProvider = {
  async getMigrations() {
    const migrations = await new SqlFileMigrationProvider().getMigrations();
    return Object.fromEntries(Object.entries(migrations).filter(([name]) => name !== MIGRATION));
  },
};

describe('the live Depop shop, no longer protected (real Postgres)', () => {
  let scratch: ScratchDatabase;
  let db: Db;
  let theirs: { accountId: string; connectionId: string };
  let stillProtected: { accountId: string; connectionId: string };
  let ownReadOnly: { accountId: string; connectionId: string };

  async function link(accountId: string, sellerId: string): Promise<string> {
    const connection = await db
      .insertInto('marketplace_connection')
      .values({ account_id: accountId, marketplace: 'depop', mode: 'api' })
      .returning('id')
      .executeTakeFirstOrThrow();
    // The session check names the shop, as a link does.
    await db
      .updateTable('marketplace_connection')
      .set({ external_user_id: sellerId })
      .where('id', '=', connection.id)
      .execute();
    return connection.id;
  }

  async function readOnly(connectionId: string): Promise<boolean> {
    const row = await db
      .selectFrom('marketplace_connection')
      .select('read_only')
      .where('id', '=', connectionId)
      .executeTakeFirstOrThrow();
    return row.read_only;
  }

  async function keptReadOnly(accountId: string): Promise<{ sellers: string[]; depop: boolean }> {
    const sellers = await db
      .selectFrom('read_only_seller')
      .select('seller_id')
      .where('account_id', '=', accountId)
      .execute();
    const depop = await db
      .selectFrom('marketplace_read_only')
      .select('marketplace')
      .where('account_id', '=', accountId)
      .where('marketplace', '=', 'depop')
      .executeTakeFirst();
    return { sellers: sellers.map((row) => row.seller_id), depop: depop !== undefined };
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase('live_shop_unprotected');
    db = createDatabase({ connectionString: scratch.url, max: 4 });
    await new SchemaMigrator(db, withoutMigration).migrateToLatest();
    // The live shop's seller id is never in the repository, so in this scratch database the
    // invented one stands in for it by its digest.
    await sql`
      create or replace function seller_digest(seller_id text) returns text
      language sql immutable strict parallel safe
      return case
        when seller_id = ${sql.lit(LIVE_SHOP)} then ${sql.lit(LIVE_SHOP_DIGEST)}
        else encode(sha256(convert_to(seller_id, 'UTF8')), 'hex')
      end
    `.execute(db);
    await db
      .insertInto('protected_seller')
      .values({
        marketplace: 'depop',
        seller_digest: sql<string>`seller_digest(${'another-protected-shop'})`,
        reason: 'test shop',
      })
      .execute();

    const theirAccount = await insertAccount(db, 'TR', 'Their account');
    theirs = { accountId: theirAccount, connectionId: await link(theirAccount, LIVE_SHOP) };
    const otherAccount = await insertAccount(db, 'OT', 'Other account');
    stillProtected = {
      accountId: otherAccount,
      connectionId: await link(otherAccount, 'another-protected-shop'),
    };
    const ownerAccount = await insertAccount(db, 'OW', 'Owner account');
    ownReadOnly = { accountId: ownerAccount, connectionId: await link(ownerAccount, 'test-shop') };
    await setConnectionReadOnly(db, ownReadOnly, true);
  });

  afterAll(async () => {
    await db.destroy();
    await scratch.drop();
  });

  it('makes the formerly protected shop writable, and its Read only switch work both ways', async () => {
    // Before: protected, and the owner can't turn its Read only off.
    expect(await readOnly(theirs.connectionId)).toBe(true);
    expect(await keptReadOnly(theirs.accountId)).toEqual({ sellers: [LIVE_SHOP], depop: true });
    await expect(setConnectionReadOnly(db, theirs, false)).rejects.toBeInstanceOf(
      ProtectedShopError,
    );

    expect(await new SchemaMigrator(db).migrateToLatest()).toEqual([MIGRATION]);

    // Writable, with nothing of the protection left on the account.
    expect(await readOnly(theirs.connectionId)).toBe(false);
    expect(await keptReadOnly(theirs.accountId)).toEqual({ sellers: [], depop: false });
    const shops = await db.selectFrom('protected_seller').select('seller_digest').execute();
    expect(shops.map((shop) => shop.seller_digest)).not.toContain(LIVE_SHOP_DIGEST);

    // Nothing else changed: another protected shop, and an owner's own read only.
    expect(await readOnly(stillProtected.connectionId)).toBe(true);
    await expect(setConnectionReadOnly(db, stillProtected, false)).rejects.toBeInstanceOf(
      ProtectedShopError,
    );
    expect(await readOnly(ownReadOnly.connectionId)).toBe(true);
    expect(await keptReadOnly(ownReadOnly.accountId)).toEqual({
      sellers: ['test-shop'],
      depop: true,
    });

    // The Read only switch works both ways on the shop.
    expect(await setConnectionReadOnly(db, theirs, true)).toEqual({
      marketplace: 'depop',
      refused: [],
    });
    expect(await readOnly(theirs.connectionId)).toBe(true);
    expect(await keptReadOnly(theirs.accountId)).toEqual({ sellers: [LIVE_SHOP], depop: true });
    expect(await setConnectionReadOnly(db, theirs, false)).toEqual({
      marketplace: 'depop',
      refused: [],
    });
    expect(await readOnly(theirs.connectionId)).toBe(false);
    expect(await keptReadOnly(theirs.accountId)).toEqual({ sellers: [], depop: false });

    // A relink of the shop on the account is writable.
    await db.deleteFrom('marketplace_connection').where('id', '=', theirs.connectionId).execute();
    theirs = { accountId: theirs.accountId, connectionId: await link(theirs.accountId, LIVE_SHOP) };
    expect(await readOnly(theirs.connectionId)).toBe(false);
  });

  it('protects the shop again when reverted', async () => {
    expect(await new SchemaMigrator(db).migrateDown()).toEqual([MIGRATION]);
    expect(await readOnly(theirs.connectionId)).toBe(true);
    await expect(setConnectionReadOnly(db, theirs, false)).rejects.toBeInstanceOf(
      ProtectedShopError,
    );
    expect(await readOnly(ownReadOnly.connectionId)).toBe(true);
  });
});

/**
 * Linking and listings on real Postgres: a link takes the marketplace's listings that were never
 * on a shop, a relink of the same connection keeps its listings, and after an unlink the next
 * link (perhaps of another shop) takes none of the unlinked shop's listings: they stay without a
 * connection, marked as from the previous shop (docs/features/marketplace-linking.md).
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createInventoryItem, inTransaction } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import { LocalTokenVault, SessionVault, startConnectionDeletion } from '@listora/connections';

import { linkAutomationSession } from './link.ts';
import { automationProfile } from './profiles.ts';
import { silentLogger } from './test-support.ts';

describe('linking and the marketplace listings (real Postgres)', () => {
  let database: MigratedDatabase;
  let accountId: string;
  const vault = new SessionVault({
    vault: new LocalTokenVault(randomBytes(32)),
    logger: silentLogger,
  });
  const profile = automationProfile('depop');

  beforeAll(async () => {
    database = await createMigratedDatabase('link', { jobQueue: true });
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    accountId = await insertAccount(database.db);
  });

  const link = (shop: string) =>
    linkAutomationSession(
      database.db,
      { vault, profile },
      {
        accountId,
        marketplace: 'depop',
        cookies: [
          {
            name: 'access_token',
            value: shop,
            domain: '.depop.com',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ],
        runsOn: 'cloud',
      },
    );

  // A connection deleted while its listings stay (access revoked past retention): the owner's
  // own unlink removes the listings instead (packages/connections, marketplace-data.ts).
  const unlink = (connectionId: string) =>
    inTransaction(database.db, (trx) =>
      startConnectionDeletion(trx, { accountId, connectionId, reason: 'revoked' }),
    );

  async function newListing(
    title: string,
    connectionId: string | null,
    status: 'active' | 'ended' = 'active',
  ): Promise<string> {
    const item = await createInventoryItem(database.db, accountId, { title });
    const { id } = await database.db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId,
        item_id: item.id,
        marketplace: 'depop',
        connection_id: connectionId,
        status,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return id;
  }

  const listing = (id: string) =>
    database.db
      .selectFrom('marketplace_listing')
      .select(['connection_id', 'shop_unlinked_at', 'status'])
      .where('account_id', '=', accountId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  it("takes the marketplace's listings that were never on a shop", async () => {
    const before = await newListing('Listed before linking', null);
    const { connectionId } = await link('first-shop');
    expect(await listing(before)).toMatchObject({
      connection_id: connectionId,
      shop_unlinked_at: null,
    });
  });

  it('keeps the listings of a connection relinked in place', async () => {
    const { connectionId } = await link('first-shop');
    const own = await newListing('Own listing', connectionId);
    const relinked = await link('first-shop');
    expect(relinked.connectionId).toBe(connectionId);
    expect(await listing(own)).toMatchObject({
      connection_id: connectionId,
      shop_unlinked_at: null,
    });
  });

  it("never moves an unlinked shop's listings onto the next link, another shop", async () => {
    const previous = await link('test-shop');
    const active = await newListing('Test shop listing', previous.connectionId);
    const ended = await newListing('Ended test listing', previous.connectionId, 'ended');
    await unlink(previous.connectionId);

    const next = await link('live-shop');
    expect(next.connectionId).not.toBe(previous.connectionId);
    for (const id of [active, ended]) {
      const row = await listing(id);
      expect(row.connection_id).toBeNull();
      expect(row.shop_unlinked_at).toBeInstanceOf(Date);
    }
    // A relink of the new shop (its session expired) leaves them out too.
    await link('live-shop');
    expect((await listing(active)).connection_id).toBeNull();
    // The new shop's own listings stay on it.
    const own = await newListing('Live shop listing', next.connectionId);
    expect((await listing(own)).connection_id).toBe(next.connectionId);
  });

  it('refuses a listing marked as from a previous shop that is still on a connection', async () => {
    const { connectionId } = await link('first-shop');
    const own = await newListing('Own listing', connectionId);
    await expect(
      database.db
        .updateTable('marketplace_listing')
        .set({ shop_unlinked_at: new Date() })
        .where('id', '=', own)
        .execute(),
    ).rejects.toThrow(/marketplace_listing_unlinked_shop_has_no_connection/);
  });
});

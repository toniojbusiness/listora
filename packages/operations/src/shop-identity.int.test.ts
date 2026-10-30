import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ProtectedShopError, READ_ONLY_ERROR, setConnectionReadOnly } from './read-only.ts';
import { recordConnectionSeller, SHOP_CHANGED_ERROR } from './shop-identity.ts';
import { createEngineHarness, type EngineHarness, type ListingRow } from './test-support.ts';

const PRICE = { priceCents: 2200, currency: 'USD' } as const;

describe('the shop a connection holds (real Postgres)', () => {
  let harness: EngineHarness;
  let connectionId: string;

  beforeAll(async () => {
    harness = await createEngineHarness('shop_identity');
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.db.updateTable('marketplace_listing').set({ connection_id: null }).execute();
    await harness.db.deleteFrom('marketplace_connection').execute();
    await harness.db.deleteFrom('marketplace_read_only').execute();
    await harness.db.deleteFrom('read_only_seller').execute();
    const connection = await harness.db
      .insertInto('marketplace_connection')
      .values({ account_id: harness.accountId, marketplace: 'ebay', mode: 'api' })
      .returning('id')
      .executeTakeFirstOrThrow();
    connectionId = connection.id;
  });

  const key = () => ({ accountId: harness.accountId, connectionId });

  async function connectedListing(): Promise<ListingRow> {
    const listing = await harness.createListing('ebay');
    return harness.db
      .updateTable('marketplace_listing')
      .set({ connection_id: connectionId })
      .where('id', '=', listing.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async function newConnection(): Promise<string> {
    const connection = await harness.db
      .insertInto('marketplace_connection')
      .values({ account_id: harness.accountId, marketplace: 'ebay', mode: 'api' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return connection.id;
  }

  async function readOnly(): Promise<boolean> {
    const row = await harness.db
      .selectFrom('marketplace_connection')
      .select('read_only')
      .where('id', '=', connectionId)
      .executeTakeFirstOrThrow();
    return row.read_only;
  }

  /** Protects the shop `sellerId` names on eBay; returns the row's id. */
  async function protectShop(sellerId: string): Promise<string> {
    const shop = await harness.db
      .insertInto('protected_seller')
      .values({
        marketplace: 'ebay',
        seller_digest: sql<string>`seller_digest(${sellerId})`,
        reason: 'test shop',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return shop.id;
  }

  async function heldSeller(): Promise<string | null> {
    const row = await harness.db
      .selectFrom('marketplace_connection')
      .select('external_user_id')
      .where('id', '=', connectionId)
      .executeTakeFirstOrThrow();
    return row.external_user_id;
  }

  it('records the first seller a check reads, and changes nothing when it reads the same one', async () => {
    const listing = await connectedListing();
    const price = await harness.enqueue(listing, 'price', PRICE);

    expect(await recordConnectionSeller(harness.db, key(), 'first-shop')).toEqual({
      marketplace: 'ebay',
      changed: false,
      becameReadOnly: false,
      becameWritable: false,
      refused: [],
    });
    expect(await heldSeller()).toBe('first-shop');
    expect(await recordConnectionSeller(harness.db, key(), 'first-shop')).toMatchObject({
      changed: false,
      refused: [],
    });
    // The listing and its waiting change stay with the shop.
    expect((await harness.listing(listing.id)).connection_id).toBe(connectionId);
    expect((await harness.operation(price.id)).status).toBe('queued');
  });

  it('gives up the listings and waiting changes of the previous shop when the session signs into another', async () => {
    await recordConnectionSeller(harness.db, key(), 'test-shop');
    const listing = await connectedListing();
    const price = await harness.enqueue(listing, 'price', PRICE);

    const recorded = await recordConnectionSeller(harness.db, key(), 'other-shop');
    expect(recorded).toEqual({
      marketplace: 'ebay',
      changed: true,
      becameReadOnly: false,
      becameWritable: false,
      refused: [price.id],
    });
    expect(await heldSeller()).toBe('other-shop');
    // Nothing waiting for the previous shop reaches this one: failed visibly, never sent.
    expect(await harness.operation(price.id)).toMatchObject({
      status: 'failed',
      error_code: SHOP_CHANGED_ERROR,
    });
    // The listing left the connection as a revoked connection's deletion leaves it: from the
    // previous shop.
    const left = await harness.listing(listing.id);
    expect(left.connection_id).toBeNull();
    expect(left.shop_unlinked_at).not.toBeNull();
  });

  it('makes the connection read only again when it comes to hold a seller the account kept read only', async () => {
    await recordConnectionSeller(harness.db, key(), 'live-shop');
    await setConnectionReadOnly(harness.db, key(), true);
    // The owner relinks their test shop and lets Listora change it.
    await recordConnectionSeller(harness.db, key(), 'test-shop');
    await setConnectionReadOnly(harness.db, key(), false);
    const listing = await connectedListing();
    const price = await harness.enqueue(listing, 'price', PRICE);

    // The live shop signs in on the connection again: read only, and the waiting change fails.
    const recorded = await recordConnectionSeller(harness.db, key(), 'live-shop');
    expect(recorded).toMatchObject({ changed: true, becameReadOnly: true });
    expect(recorded?.refused).toEqual([price.id]);
    expect(await harness.operation(price.id)).toMatchObject({
      status: 'failed',
      error_code: SHOP_CHANGED_ERROR,
    });
    const row = await harness.db
      .selectFrom('marketplace_connection')
      .select('read_only')
      .where('id', '=', connectionId)
      .executeTakeFirstOrThrow();
    expect(row.read_only).toBe(true);
    // A change asked for now is refused as on any read-only connection.
    const after = await harness.createListing('ebay');
    await expect(harness.enqueue(after, 'end', { status: 'ended' })).rejects.toThrow('read only');
  });

  it('fails the waiting changes with the read-only error when a first-seen seller is kept read only', async () => {
    await harness.db
      .insertInto('read_only_seller')
      .values({ account_id: harness.accountId, marketplace: 'ebay', seller_id: 'live-shop' })
      .execute();
    const listing = await connectedListing();
    const price = await harness.enqueue(listing, 'price', PRICE);

    const recorded = await recordConnectionSeller(harness.db, key(), 'live-shop');
    expect(recorded).toEqual({
      marketplace: 'ebay',
      changed: false,
      becameReadOnly: true,
      becameWritable: false,
      refused: [price.id],
    });
    expect(await harness.operation(price.id)).toMatchObject({
      status: 'failed',
      error_code: READ_ONLY_ERROR,
    });
  });

  it('lets another shop on a read-only connection be changed: read only stays with the shop it held', async () => {
    await recordConnectionSeller(harness.db, key(), 'live-shop');
    await setConnectionReadOnly(harness.db, key(), true);

    // The owner relinks the account with their test shop: it is not the live shop.
    expect(await recordConnectionSeller(harness.db, key(), 'test-shop')).toMatchObject({
      changed: true,
      becameWritable: true,
    });
    expect(await readOnly()).toBe(false);
    // Its Read only works both ways for the owner.
    await setConnectionReadOnly(harness.db, key(), true);
    expect(await readOnly()).toBe(true);
    await setConnectionReadOnly(harness.db, key(), false);
    expect(await readOnly()).toBe(false);
    // The live shop is still kept read only by the account.
    expect(await recordConnectionSeller(harness.db, key(), 'live-shop')).toMatchObject({
      becameReadOnly: true,
    });
  });

  it('starts a new link of a read-only marketplace read only, then follows the shop its check names', async () => {
    await recordConnectionSeller(harness.db, key(), 'live-shop');
    await setConnectionReadOnly(harness.db, key(), true);
    // The connection goes another way (an unlink does not take a read-only one).
    await harness.db.deleteFrom('marketplace_connection').where('id', '=', connectionId).execute();

    // A new link is read only until its check names the shop.
    connectionId = await newConnection();
    expect(await readOnly()).toBe(true);
    expect(await recordConnectionSeller(harness.db, key(), 'test-shop')).toMatchObject({
      changed: false,
      becameWritable: true,
    });
    expect(await readOnly()).toBe(false);

    // With the account's marketplace read only again, the live shop linked the same way stays
    // read only.
    await setConnectionReadOnly(harness.db, key(), true);
    await harness.db.deleteFrom('marketplace_connection').where('id', '=', connectionId).execute();
    connectionId = await newConnection();
    expect(await recordConnectionSeller(harness.db, key(), 'live-shop')).toMatchObject({
      becameWritable: false,
    });
    expect(await readOnly()).toBe(true);
  });

  it("keeps the owner's Read only on a connection whose shop was not named yet", async () => {
    await setConnectionReadOnly(harness.db, key(), true);
    expect(await recordConnectionSeller(harness.db, key(), 'live-shop')).toMatchObject({
      becameWritable: false,
    });
    expect(await readOnly()).toBe(true);
    const kept = await harness.db
      .selectFrom('read_only_seller')
      .select('seller_id')
      .where('account_id', '=', harness.accountId)
      .execute();
    expect(kept).toEqual([{ seller_id: 'live-shop' }]);
  });

  it('refuses to let Listora change a protected shop, and changes nothing', async () => {
    await recordConnectionSeller(harness.db, key(), 'protected-shop');
    const shop = await protectShop('protected-shop');
    try {
      await setConnectionReadOnly(harness.db, key(), true);
      await expect(setConnectionReadOnly(harness.db, key(), false)).rejects.toBeInstanceOf(
        ProtectedShopError,
      );
      await expect(setConnectionReadOnly(harness.db, key(), false)).rejects.toThrow(
        'This eBay shop is protected, so Listora will only ever read it and Read only stays on.',
      );
      // Whatever sets it, the database keeps it read only.
      await harness.db
        .updateTable('marketplace_connection')
        .set({ read_only: false })
        .where('id', '=', connectionId)
        .execute();
      const row = await harness.db
        .selectFrom('marketplace_connection')
        .select('read_only')
        .where('id', '=', connectionId)
        .executeTakeFirstOrThrow();
      expect(row.read_only).toBe(true);
    } finally {
      await harness.db.deleteFrom('protected_seller').where('id', '=', shop).execute();
    }
  });

  it('keeps a protected shop read only when it is linked again, and never protects the shop linked after it', async () => {
    // The live shop's connection, read only, whose seller was never recorded (linked before
    // connections knew their shop), relinked with the owner's test shop.
    const shop = await protectShop('live-shop');
    try {
      await setConnectionReadOnly(harness.db, key(), true);
      await recordConnectionSeller(harness.db, key(), 'test-shop');
      // The test shop is not protected: the owner turns its Read only off and on.
      await setConnectionReadOnly(harness.db, key(), false);
      expect(await readOnly()).toBe(false);
      await setConnectionReadOnly(harness.db, key(), true);
      await setConnectionReadOnly(harness.db, key(), false);
      expect(await readOnly()).toBe(false);

      // The live shop signs in again: read only, and it stays so.
      expect(await recordConnectionSeller(harness.db, key(), 'live-shop')).toMatchObject({
        changed: true,
        becameReadOnly: true,
      });
      await expect(setConnectionReadOnly(harness.db, key(), false)).rejects.toBeInstanceOf(
        ProtectedShopError,
      );
      expect(await readOnly()).toBe(true);

      // Linked on a new connection with the account's marketplace writable, it is read only as
      // soon as its check names it.
      await harness.db
        .deleteFrom('marketplace_connection')
        .where('id', '=', connectionId)
        .execute();
      await harness.db.deleteFrom('marketplace_read_only').execute();
      connectionId = await newConnection();
      expect(await readOnly()).toBe(false);
      expect(await recordConnectionSeller(harness.db, key(), 'live-shop')).toMatchObject({
        becameReadOnly: true,
      });
      await expect(setConnectionReadOnly(harness.db, key(), false)).rejects.toBeInstanceOf(
        ProtectedShopError,
      );
    } finally {
      await harness.db.deleteFrom('protected_seller').where('id', '=', shop).execute();
    }
  });

  it('says so for a connection the account does not have', async () => {
    await expect(
      recordConnectionSeller(
        harness.db,
        { accountId: harness.accountId, connectionId: '0199a1f0-0000-7000-8000-00000000dead' },
        'any-shop',
      ),
    ).resolves.toBeUndefined();
  });
});

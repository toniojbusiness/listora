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
      refused: [price.id],
    });
    expect(await heldSeller()).toBe('other-shop');
    // Nothing waiting for the previous shop reaches this one: failed visibly, never sent.
    expect(await harness.operation(price.id)).toMatchObject({
      status: 'failed',
      error_code: SHOP_CHANGED_ERROR,
    });
    // The listing left the connection as an unlink leaves it: from the previous shop.
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
      refused: [price.id],
    });
    expect(await harness.operation(price.id)).toMatchObject({
      status: 'failed',
      error_code: READ_ONLY_ERROR,
    });
  });

  it('refuses to let Listora change a protected shop, and changes nothing', async () => {
    await recordConnectionSeller(harness.db, key(), 'protected-shop');
    const shop = await harness.db
      .insertInto('protected_seller')
      .values({ marketplace: 'ebay', seller_id: 'protected-shop', reason: 'test shop' })
      .returning('id')
      .executeTakeFirstOrThrow();
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
      await harness.db.deleteFrom('protected_seller').where('id', '=', shop.id).execute();
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

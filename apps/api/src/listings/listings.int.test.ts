import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, fieldsOf, type TestApi } from '../test-support.ts';

const OWNER = 'antonio.jenkins@example.com';
const OTHER = 'someone.else@example.com';

const POSHMARK = 'https://poshmark.com/listing/Lululemon-Align-Pant-25-64f1a2b3c4d5e6f7a8b9c0d1';

describe('shared listing links (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let otherToken: string;

  beforeAll(async () => {
    api = await createTestApi('listings');
    token = await api.signIn(OWNER);
    otherToken = await api.signIn(OTHER);
  });

  afterAll(async () => {
    await api.close();
  });

  async function createItem(title = 'Lululemon Align pant', as = token) {
    const response = await api.call('createItem', { token: as, body: { details: { title } } });
    expect(response.status).toBe(201);
    return response.body;
  }

  const link = (itemId: string, url: string, options: { as?: string; key?: string } = {}) =>
    api.call('linkItemListing', {
      token: options.as ?? token,
      params: { itemId },
      body: { url },
      ...(options.key === undefined ? {} : { idempotencyKey: options.key }),
    });

  const importListing = (url: string, title: string, as = token) =>
    api.call('importSharedListing', { token: as, body: { url, title } });

  const countItems = async () => {
    const { count } = await api.db
      .selectFrom('inventory_item')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(count);
  };

  describe('linkItemListing', () => {
    it('records the listing as assisted, active, and confirmed by the user', async () => {
      const item = await createItem();
      const response = await link(item.id, `${POSHMARK}?utm_source=pm_share`);

      expect(response.status).toBe(201);
      const listing = response.body;
      expect(listing).toMatchObject({
        itemId: item.id,
        marketplace: 'poshmark',
        mode: 'assisted',
        status: 'active',
        statusDisplay: { tone: 'success', label: 'Active (you confirmed)' },
        verification: { method: 'user_confirmation' },
        externalListingId: '64f1a2b3c4d5e6f7a8b9c0d1',
        // The canonical URL: no tracking query.
        externalUrl: POSHMARK,
        availableActions: [],
      });
      // Listora never read the listing, so it has no title or price of its own, and no
      // read-back time.
      expect(listing.variant).toBeUndefined();
      expect(listing.lastVerifiedAt).toBeUndefined();

      const fetched = await api.call('getItem', { token, params: { itemId: item.id } });
      expect(fetched.body.status).toBe('listed');
      expect(fetched.body.listings).toEqual([listing]);

      const page = await api.call('listItems', { token, query: { q: item.sku } });
      expect(page.body.data[0]?.listings).toEqual([
        {
          listingId: listing.id,
          marketplace: 'poshmark',
          mode: 'assisted',
          status: 'active',
          statusDisplay: { tone: 'success', label: 'Active (you confirmed)' },
        },
      ]);

      const history = await api.db
        .selectFrom('audit_log')
        .select(['action', 'changes', 'actor_kind'])
        .where('item_id', '=', item.id)
        .where('action', '=', 'listing.linked')
        .execute();
      expect(history).toEqual([
        {
          action: 'listing.linked',
          actor_kind: 'user',
          changes: {
            listingId: listing.id,
            marketplace: 'poshmark',
            url: POSHMARK,
            externalListingId: '64f1a2b3c4d5e6f7a8b9c0d1',
            status: { from: 'draft', to: 'listed' },
          },
        },
      ]);
    });

    it('never labels a linked listing as confirmed by the marketplace, even on eBay', async () => {
      const urls = [
        'https://www.ebay.com/itm/Levis-501/266512345678?hash=item3e0d',
        'https://www.mercari.com/us/item/m12345678901/',
        'https://www.depop.com/products/janedoe-vintage-nike-windbreaker-90s/',
        'https://ebay.us/m/Ab3dE9',
      ];
      for (const url of urls) {
        const item = await createItem();
        const response = await link(item.id, url);
        expect(response.status).toBe(201);
        expect(response.body.mode).toBe('assisted');
        expect(response.body.verification?.method).toBe('user_confirmation');
        expect(response.body.statusDisplay.label).toBe('Active (you confirmed)');
        expect(response.body.statusDisplay.label).not.toMatch(/confirmed by/i);
      }
    });

    it('keeps a short link as given, without a listing id, and links it only once', async () => {
      const first = await createItem();
      const second = await createItem();
      const url = 'https://posh.mk/aBc12XyZ';

      const linked = await link(first.id, url);
      expect(linked.status).toBe(201);
      expect(linked.body.externalUrl).toBe(url);
      expect(linked.body.externalListingId).toBeUndefined();

      const again = await link(second.id, url);
      expect(again.status).toBe(409);
      expect(again.error.code).toBe('already_exists');
      expect(again.error.message).toBe(`This Poshmark listing is already linked to ${first.sku}.`);
    });

    it('links a listing id once per account, whatever URL shape names it', async () => {
      const first = await createItem();
      const second = await createItem();
      expect((await link(first.id, 'https://www.mercari.com/us/item/m22222222222/')).status).toBe(
        201,
      );

      const duplicate = await link(second.id, 'https://mercari.com/item/m22222222222?ref=share');
      expect(duplicate.status).toBe(409);
      expect(duplicate.error.message).toBe(
        `This Mercari listing is already linked to ${first.sku}.`,
      );

      // Another account is a different seller: the same URL is theirs to link.
      const theirs = await createItem('Their pant', otherToken);
      const other = await link(theirs.id, 'https://www.mercari.com/us/item/m22222222222/', {
        as: otherToken,
      });
      expect(other.status).toBe(201);
    });

    it('allows one live listing per marketplace on an item', async () => {
      const item = await createItem();
      expect(
        (await link(item.id, 'https://www.depop.com/products/janedoe-jacket-a1/')).status,
      ).toBe(201);
      const second = await link(item.id, 'https://www.depop.com/products/janedoe-jacket-b2/');
      expect(second.status).toBe(409);
      expect(second.error).toMatchObject({
        code: 'already_exists',
        message: `${item.sku} already has a live Depop listing.`,
      });

      // Other marketplaces are independent, and the item stays listed.
      const ebay = await link(item.id, 'https://www.ebay.com/itm/123456789012');
      expect(ebay.status).toBe(201);
      const fetched = await api.call('getItem', { token, params: { itemId: item.id } });
      expect(fetched.body.listings.map((listing) => listing.marketplace)).toEqual([
        'depop',
        'ebay',
      ]);
    });

    it('lets an item whose listing ended be linked to a new listing on that marketplace', async () => {
      const item = await createItem();
      const first = await link(item.id, 'https://poshmark.com/listing/64f1a2b3c4d5e6f7a8b9c0aa');
      await api.db
        .updateTable('marketplace_listing')
        .set({ status: 'ended', ended_at: new Date() })
        .where('id', '=', first.body.id)
        .execute();

      const relinked = await link(item.id, 'https://poshmark.com/listing/64f1a2b3c4d5e6f7a8b9c0ab');
      expect(relinked.status).toBe(201);
      // The item shows its newest listing per marketplace.
      const fetched = await api.call('getItem', { token, params: { itemId: item.id } });
      expect(fetched.body.listings.map((listing) => listing.id)).toEqual([relinked.body.id]);
    });

    it('rejects a URL that is not a listing on a supported marketplace, saying why', async () => {
      const item = await createItem();
      const closet = await link(item.id, 'https://poshmark.com/closet/janedoe');
      expect(closet.status).toBe(422);
      expect(closet.error.code).toBe('validation_failed');
      expect(fieldsOf(closet)).toEqual(['url']);
      expect(closet.error.message).toBe(
        'This is not a Poshmark listing. Share the listing itself.',
      );

      const elsewhere = await link(item.id, 'https://example.com/itm/266512345678');
      expect(elsewhere.status).toBe(422);
      expect(fieldsOf(elsewhere)).toEqual(['url']);

      const fetched = await api.call('getItem', { token, params: { itemId: item.id } });
      expect(fetched.body).toMatchObject({ status: 'draft', listings: [] });
    });

    it('refuses an item that is sold, shipped, archived, or being delisted', async () => {
      for (const status of ['archived', 'sold', 'shipped', 'sold_pending_delist'] as const) {
        const item = await createItem();
        await api.db
          .updateTable('inventory_item')
          .set({ status, pre_archive_status: status === 'archived' ? 'draft' : null })
          .where('id', '=', item.id)
          .execute();
        const response = await link(item.id, `https://www.ebay.com/itm/${String(Date.now())}1`);
        expect(response.status).toBe(409);
        expect(response.error.code).toBe('invalid_state_transition');
        expect(response.error.message).toBe(
          `${item.sku} is ${status.replaceAll('_', ' ')}, so a listing cannot be linked to it.`,
        );
      }
    });

    it("answers 404 for another account's item and changes nothing", async () => {
      const theirs = await createItem('Their jacket', otherToken);
      const response = await link(theirs.id, 'https://www.ebay.com/itm/555555555555');
      expect(response.status).toBe(404);
      const fetched = await api.call('getItem', {
        token: otherToken,
        params: { itemId: theirs.id },
      });
      expect(fetched.body).toMatchObject({ status: 'draft', listings: [] });
    });

    it('replays a retry with the same Idempotency-Key instead of linking twice', async () => {
      const item = await createItem();
      const key = randomUUID();
      const url = 'https://www.ebay.com/itm/777777777777';
      const first = await link(item.id, url, { key });
      const retry = await link(item.id, url, { key });
      expect(retry.status).toBe(201);
      expect(retry.body).toEqual(first.body);
      const rows = await api.db
        .selectFrom('marketplace_listing')
        .select('id')
        .where('item_id', '=', item.id)
        .execute();
      expect(rows).toHaveLength(1);
    });

    it('links each listing once when the same share is sent twice at the same time', async () => {
      const [first, second] = await Promise.all([createItem(), createItem()]);
      const url = 'https://poshmark.com/listing/64f1a2b3c4d5e6f7a8b9c0ff';
      const responses = await Promise.all([link(first.id, url), link(second.id, url)]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    });
  });

  describe('importSharedListing', () => {
    it('creates a listed placeholder item with the next SKU and links the listing', async () => {
      const url = 'https://merc.li/Qw8rT5uV';
      const response = await importListing(url, '  Vintage Levi trucker jacket ');

      expect(response.status).toBe(201);
      const { item, listing } = response.body;
      expect(item).toMatchObject({
        status: 'listed',
        details: { title: 'Vintage Levi trucker jacket', quantity: 1 },
        fieldProvenance: { title: 'user' },
        photos: [],
      });
      expect(item.sku).toMatch(/^AJ-\d{6}$/);
      expect(listing).toMatchObject({
        itemId: item.id,
        marketplace: 'mercari',
        mode: 'assisted',
        status: 'active',
        statusDisplay: { tone: 'success', label: 'Active (you confirmed)' },
        externalUrl: url,
      });
      expect(item.listings).toEqual([listing]);

      const history = await api.db
        .selectFrom('audit_log')
        .select('action')
        .where('item_id', '=', item.id)
        .orderBy('id')
        .execute();
      expect(history.map((entry) => entry.action)).toEqual(['item.created', 'listing.linked']);
    });

    it('creates no item when the listing is already linked', async () => {
      const url = 'https://www.depop.com/products/janedoe-import-twice/';
      const first = await importListing(url, 'Nike windbreaker');
      expect(first.status).toBe(201);
      const before = await countItems();

      const again = await importListing(url, 'Nike windbreaker');
      expect(again.status).toBe(409);
      expect(again.error.message).toBe(
        `This Depop listing is already linked to ${first.body.item.sku}.`,
      );
      expect(await countItems()).toBe(before);
    });

    it('rejects a blank title or an unsupported URL and creates no item', async () => {
      const before = await countItems();
      const blank = await importListing('https://www.ebay.com/itm/888888888888', '   ');
      expect(blank.status).toBe(422);
      expect(fieldsOf(blank)).toEqual(['title']);

      const unsupported = await importListing('https://example.com/listing/1', 'Jacket');
      expect(unsupported.status).toBe(422);
      expect(fieldsOf(unsupported)).toEqual(['url']);
      expect(await countItems()).toBe(before);
    });
  });
});

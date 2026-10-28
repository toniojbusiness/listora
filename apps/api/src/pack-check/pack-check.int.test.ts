import { createInventoryItem, jsonb, type Marketplace } from '@listora/db';
import { ordersToRead, recordLabelReads } from '@listora/pack-check';
import { DOUBLE_PRINT } from '@listora/pack-check/testing';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';
import type { Tenant } from '../tenancy.ts';

const OWNER = 'pack.owner@example.com';
const OTHER = 'pack.other@example.com';
const HOUR = 3_600_000;

describe('pack check (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let tenant: Tenant;

  beforeAll(async () => {
    api = await createTestApi('pack_check');
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
  });

  afterAll(async () => {
    await api.close();
  });

  /** A sold item with a ready cover photo, on its shelf, in an order that still needs packing. */
  async function order(options: {
    title: string;
    brand?: string;
    category?: string;
    size?: string;
    color?: string;
    marketplace?: Marketplace;
    tracking?: string;
    buyer?: string;
    accountId?: string;
  }): Promise<{ saleId: string; itemId: string; sku: string }> {
    const accountId = options.accountId ?? tenant.accountId;
    const location = await api.db
      .insertInto('storage_location')
      .values({
        account_id: accountId,
        code: `S-${String(Math.floor(Math.random() * 1e6))}`,
        label: 'Shelf',
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    const item = await createInventoryItem(api.db, accountId, {
      title: options.title,
      brand: options.brand ?? null,
      category: options.category ?? null,
      size_label: options.size ?? null,
      colors: options.color === undefined ? [] : [options.color],
      status: 'sold',
      storage_location_id: location.id,
    });
    const derivative = (kind: string) => ({
      key: `public/photos/${item.id}/${kind}.jpg`,
      width: 400,
      height: 400,
      byteSize: 1000,
      sha256: 'a'.repeat(64),
    });
    await api.db
      .insertInto('photo')
      .values({
        account_id: accountId,
        item_id: item.id,
        position: 0,
        role: 'front',
        storage_key: `uploads/${item.id}`,
        width: 1200,
        height: 1200,
        sha256: 'b'.repeat(64),
        phash: '0'.repeat(16),
        status: 'ready',
        processed_at: new Date(api.clock.now),
        derivatives: jsonb({
          original: derivative('original'),
          ai: derivative('ai'),
          thumbnail: derivative('thumbnail'),
          listing: derivative('listing'),
        }),
      })
      .execute();
    const marketplace = options.marketplace ?? 'depop';
    const sale = await api.db
      .insertInto('sale')
      .values({
        account_id: accountId,
        marketplace,
        external_order_id: `order-${item.id}`,
        sold_at: new Date(api.clock.now - HOUR),
        detection_source: 'poll',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await api.db
      .insertInto('sale_item')
      .values({
        account_id: accountId,
        sale_id: sale.id,
        marketplace,
        item_id: item.id,
        sale_price_cents: 2500,
      })
      .execute();
    if (options.tracking !== undefined || options.buyer !== undefined) {
      await api.db
        .insertInto('sale_label')
        .values({
          account_id: accountId,
          sale_id: sale.id,
          ...(options.tracking === undefined
            ? {}
            : { tracking_number: options.tracking, carrier: 'usps', source: 'marketplace' }),
          buyer_first_name: options.buyer ?? null,
          read_status: options.tracking === undefined ? 'no_label' : 'read',
          read_at: new Date(api.clock.now),
        })
        .execute();
    }
    return { saleId: sale.id, itemId: item.id, sku: item.sku };
  }

  const scan = (query: Record<string, string>) => api.call('checkPackScan', { token, query });
  const pack = (saleId: string, body: Record<string, unknown>) =>
    api.call('packOrder', { token, params: { saleId }, body });

  it('is off until the seller turns it on', async () => {
    expect((await api.call('getPackCheckSettings', { token })).body).toEqual({ enabled: false });
    const saved = await api.call('replacePackCheckSettings', { token, body: { enabled: true } });
    expect(saved.body).toEqual({ enabled: true });
    expect((await api.call('getPackCheckSettings', { token })).body).toEqual({ enabled: true });
  });

  it('lists each order with its item, shelf, buyer, and label', async () => {
    const tee = await order({
      title: 'Shaka Wear Max Heavyweight Tee',
      brand: 'Shaka Wear',
      category: 'clothing/tops/t_shirts',
      size: '2XL',
      color: 'Black',
      tracking: '9400111899223197420042',
      buyer: 'Sarah',
    });
    const listed = await api.call('listPackOrders', { token });
    expect(listed.status).toBe(200);
    const shown = listed.body.data.find((entry) => entry.saleId === tee.saleId);
    expect(shown).toMatchObject({
      marketplace: 'depop',
      description: 'the black Shaka Wear tee, 2XL',
      buyerFirstName: 'Sarah',
      label: { trackingNumber: '9400111899223197420042', carrier: 'usps', source: 'marketplace' },
      labelStatus: { tone: 'neutral', label: 'USPS •••• 0042 (from Depop)' },
      packStatus: { tone: 'neutral', label: 'Not packed' },
      items: [
        {
          sku: tee.sku,
          description: 'black Shaka Wear tee, 2XL',
          location: { code: expect.stringMatching(/^S-/) as string },
          photoUrl: expect.stringContaining('listing.jpg') as string,
        },
      ],
    });
  });

  it('leaves out an order from the sales history, unless the marketplace says it waits to ship', async () => {
    const old = await order({ title: 'History tee', tracking: '9400111899223197423333' });
    const waiting = await order({ title: 'History skirt' });
    await api.db
      .updateTable('sale')
      .set({ detection_source: 'history' })
      .where('id', 'in', [old.saleId, waiting.saleId])
      .execute();
    const listedIds = async () =>
      (await api.call('listPackOrders', { token })).body.data.map((entry) => entry.saleId);
    expect(await listedIds()).not.toContain(old.saleId);
    expect((await scan({ label: '9400111899223197423333' })).body.order).toBeUndefined();

    // An unread history order is read once, for how it stands on the marketplace.
    const now = new Date(api.clock.now);
    const reads = (await ordersToRead(api.db, tenant.accountId, 'depop', now)).map(
      (target) => target.saleId,
    );
    expect(reads).toEqual(expect.arrayContaining([waiting.saleId]));
    expect(reads).not.toContain(old.saleId);
    await recordLabelReads(
      api.db,
      tenant.accountId,
      [
        {
          saleId: waiting.saleId,
          status: 'read',
          trackingNumber: '9400111899223197424444',
          buyerFirstName: 'Robin',
          orderState: 'to_ship',
          carrierName: 'USPS',
          shipBy: new Date('2026-11-07T21:52:10.127Z'),
          labelExpiresAt: new Date('2026-11-24T21:52:17.000Z'),
        },
      ],
      now,
    );
    // Sold before Listora watched Depop, not shipped yet: a package all the same.
    const listed = await api.call('listPackOrders', { token });
    expect(listed.body.data.find((entry) => entry.saleId === waiting.saleId)).toMatchObject({
      shipBy: '2026-11-07T21:52:10.127Z',
      buyerFirstName: 'Robin',
      label: { trackingNumber: '9400111899223197424444', carrier: 'usps', source: 'marketplace' },
    });
    expect((await scan({ label: '9400111899223197424444' })).body.order).toMatchObject({
      saleId: waiting.saleId,
    });
    const stored = await api.db
      .selectFrom('sale_label')
      .select(['order_state', 'label_expires_at'])
      .where('sale_id', '=', waiting.saleId)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({
      order_state: 'to_ship',
      label_expires_at: new Date('2026-11-24T21:52:17.000Z'),
    });
  });

  it('never lists an order the marketplace says was refunded or shipped, whatever its label says', async () => {
    const refunded = await order({ title: 'Refunded top', tracking: '9400111899223197425555' });
    const shipped = await order({ title: 'Shipped cap', tracking: '9400111899223197426666' });
    const now = new Date(api.clock.now);
    await recordLabelReads(
      api.db,
      tenant.accountId,
      [
        {
          saleId: refunded.saleId,
          status: 'read',
          trackingNumber: '9400111899223197425555',
          buyerFirstName: null,
          orderState: 'canceled',
        },
        {
          saleId: shipped.saleId,
          status: 'read',
          trackingNumber: '9400111899223197426666',
          buyerFirstName: null,
          orderState: 'shipped',
        },
      ],
      now,
    );
    const listed = (await api.call('listPackOrders', { token })).body.data.map(
      (entry) => entry.saleId,
    );
    expect(listed).not.toContain(refunded.saleId);
    expect(listed).not.toContain(shipped.saleId);
    expect((await scan({ label: '9400111899223197425555' })).body.order).toBeUndefined();
    const reads = await ordersToRead(api.db, tenant.accountId, 'depop', now);
    expect(reads.map((target) => target.saleId)).not.toContain(refunded.saleId);
  });

  it('packs a bundle as one package: its one label goes on once, for all its items', async () => {
    const bundle = await order({ title: 'Bundle tee', tracking: '9400111899223197428888' });
    const skirt = await createInventoryItem(api.db, tenant.accountId, {
      title: 'Bundle skirt',
      status: 'sold',
    });
    await api.db
      .insertInto('sale_item')
      .values({
        account_id: tenant.accountId,
        sale_id: bundle.saleId,
        marketplace: 'depop',
        item_id: skirt.id,
        sale_price_cents: 2000,
      })
      .execute();
    const shown = (await api.call('listPackOrders', { token })).body.data.find(
      (entry) => entry.saleId === bundle.saleId,
    );
    expect(shown?.items.map((item) => item.sku)).toEqual([bundle.sku, skirt.sku]);
    expect((await scan({ label: '9400111899223197428888' })).body).toMatchObject({
      verdict: 'found',
      order: { saleId: bundle.saleId },
    });
    expect((await pack(bundle.saleId, { label: '9400111899223197428888' })).status).toBe(200);
    // A second print of it is the one package's label, already used.
    expect((await scan({ label: '9400111899223197428888' })).body).toMatchObject({
      verdict: 'already_packed',
      packedOrder: { saleId: bundle.saleId },
    });
  });

  it("is green for the right label and a red stop for the other order's label", async () => {
    const tee = await order({
      title: 'Tee',
      brand: 'Gildan',
      category: 'clothing/tops/t_shirts',
      size: 'L',
      tracking: '9400111899223197421111',
    });
    const dress = await order({
      title: 'Dress',
      brand: 'Free People',
      category: 'clothing/dresses/dresses',
      size: 'S',
      tracking: '9400111899223197422222',
    });

    const right = await scan({ label: '420941079400111899223197421111', saleId: tee.saleId });
    expect(right.body).toMatchObject({
      verdict: 'match',
      tone: 'success',
      headline: 'This label is for the Gildan tee, L.',
      canPack: true,
      order: { saleId: tee.saleId },
    });

    const wrong = await scan({ label: '9400111899223197422222', saleId: tee.saleId });
    expect(wrong.body).toMatchObject({
      verdict: 'wrong_order',
      tone: 'failed',
      headline: 'This label is for the Free People dress, S.',
      detail: 'Do not use it on this package. This package is for the Gildan tee, L.',
      canPack: false,
      order: { saleId: dress.saleId },
      expectedOrder: { saleId: tee.saleId },
    });
    const refused = await pack(tee.saleId, { label: '9400111899223197422222' });
    expect(refused.status).toBe(409);
    expect(refused.error.code).toBe('pack_refused');
    expect(refused.error.message).toContain('This label is for the Free People dress, S.');

    const found = await scan({ label: '9400111899223197422222' });
    expect(found.body).toMatchObject({ verdict: 'found', order: { saleId: dress.saleId } });
  });

  it('catches a double-printed label on the second package, with when and which order', async () => {
    const first = await order({ title: 'Order A tee', tracking: DOUBLE_PRINT.trackingA });
    const second = await order({ title: 'Order B jeans', tracking: DOUBLE_PRINT.trackingB });

    const packed = await pack(first.saleId, { label: DOUBLE_PRINT.labelA });
    expect(packed.status).toBe(200);
    expect(packed.body.pack).toMatchObject({
      trackingNumber: DOUBLE_PRINT.trackingA,
      matchedBy: 'label',
    });
    expect(packed.body.packStatus).toEqual({
      tone: 'success',
      label: 'Packed just now (label matched)',
    });

    api.clock.now += 12 * 60_000;
    const copy = await scan({ label: DOUBLE_PRINT.labelACopy, saleId: second.saleId });
    expect(copy.body).toMatchObject({
      verdict: 'already_packed',
      tone: 'failed',
      headline: 'This label was already used.',
      detail:
        'It went on the package for the Order A tee 12 minutes ago. If your printer printed it twice, throw this copy away.',
      packedOrder: { saleId: first.saleId },
      canPack: false,
    });
    const again = await pack(second.saleId, { label: DOUBLE_PRINT.labelACopy, photoCheck: true });
    expect(again.status).toBe(409);
    expect(again.error.code).toBe('pack_refused');

    // Its own label still packs the second order.
    expect((await pack(second.saleId, { label: DOUBLE_PRINT.labelB })).status).toBe(200);
  });

  it("makes the match exact with the item sticker and stops another item's sticker", async () => {
    const tee = await order({ title: 'Sticker tee', tracking: '9400111899223197423333' });
    const other = await order({ title: 'Other item', tracking: '9400111899223197424444' });
    const mismatch = await scan({
      label: '9400111899223197423333',
      sticker: `LISTORA:${other.sku}`,
      saleId: tee.saleId,
    });
    expect(mismatch.body).toMatchObject({
      verdict: 'sticker_mismatch',
      tone: 'failed',
      headline: 'This sticker is for the Other item.',
    });
    const exact = await pack(tee.saleId, {
      label: '9400111899223197423333',
      sticker: `LISTORA:${tee.sku}`,
    });
    expect(exact.body.pack).toMatchObject({ matchedBy: 'sticker', stickerSku: tee.sku });
    const asLabel = await scan({ label: `LISTORA:${tee.sku}` });
    expect(asLabel.body).toMatchObject({
      verdict: 'sticker_scanned',
      headline: "That's an item sticker.",
    });
  });

  it("packs a label Listora doesn't know only after the photo check, then guards it", async () => {
    const unknown = await order({ title: 'Mercari hoodie', marketplace: 'mercari' });
    const other = await order({ title: 'Mercari cap', marketplace: 'mercari' });
    const label = '9400111899223197425555';
    const checked = await scan({ label, saleId: unknown.saleId });
    expect(checked.body).toMatchObject({
      verdict: 'unknown_label',
      canPack: false,
      canPhotoCheck: true,
    });
    expect((await pack(unknown.saleId, { label })).status).toBe(409);
    const photo = await pack(unknown.saleId, { label, photoCheck: true });
    expect(photo.body).toMatchObject({
      label: { trackingNumber: label, source: 'scan' },
      pack: { matchedBy: 'photo' },
      labelStatus: { label: 'USPS •••• 5555 (you scanned it)' },
    });
    const reused = await scan({ label, saleId: other.saleId });
    expect(reused.body.verdict).toBe('already_packed');
  });

  it('keeps one package photo, shows it in the sale activity, and unpacks', async () => {
    const shirt = await order({ title: 'Photo shirt', tracking: '9400111899223197426666' });
    expect((await pack(shirt.saleId, { label: '9400111899223197426666' })).status).toBe(200);
    const jpeg = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 120, b: 40 } },
    })
      .jpeg()
      .toBuffer();
    const upload = await api.uploads.add(tenant, { bytes: new Uint8Array(jpeg) });
    const added = await api.call('addPackPhoto', {
      token,
      params: { saleId: shirt.saleId },
      body: { uploadFileId: upload },
    });
    expect(added.status).toBe(200);
    // Private (it shows the buyer's label): read only through a signed URL, never cached.
    const photoUrl = added.body.pack?.photoUrl ?? '';
    const signed = new URL(photoUrl);
    expect(signed.pathname).toMatch(/^\/storage\/pack\/[0-9a-f]{32}\/package\.jpg$/);
    expect(signed.searchParams.get('signature')).toBeTruthy();
    const read = await api.app.inject({ method: 'GET', url: `${signed.pathname}${signed.search}` });
    expect(read.statusCode).toBe(200);
    expect(read.headers['cache-control']).toBe('private, no-store');
    expect(read.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect((await api.app.inject({ method: 'GET', url: signed.pathname })).statusCode).toBe(404);
    signed.searchParams.set('signature', 'x'.repeat(43));
    expect(
      (await api.app.inject({ method: 'GET', url: `${signed.pathname}${signed.search}` }))
        .statusCode,
    ).toBe(404);
    const stored = await api.db
      .selectFrom('sale_pack')
      .select('photo_key')
      .where('account_id', '=', tenant.accountId)
      .where('sale_id', '=', shirt.saleId)
      .executeTakeFirstOrThrow();
    expect(stored.photo_key).toMatch(/^pack\//);

    const second = await api.uploads.add(tenant, { bytes: new Uint8Array(jpeg) });
    const refused = await api.call('addPackPhoto', {
      token,
      params: { saleId: shirt.saleId },
      body: { uploadFileId: second },
    });
    expect(refused.status).toBe(409);

    const explanation = await api.call('getSaleExplanation', {
      token,
      params: { saleId: shirt.saleId },
    });
    const kinds = explanation.body.entries.filter((entry) => entry.kind === 'package');
    expect(kinds.map((entry) => entry.title)).toEqual([
      'Package photo added',
      'Packed with the label ending 6666',
    ]);
    expect(new URL(kinds[0]?.photoUrl ?? '').pathname).toBe(new URL(photoUrl).pathname);

    expect(
      (await api.call('removePackPhoto', { token, params: { saleId: shirt.saleId } })).body.pack
        ?.photoUrl,
    ).toBeUndefined();
    const unpacked = await api.call('unpackOrder', { token, params: { saleId: shirt.saleId } });
    expect(unpacked.body.pack).toBeUndefined();
    expect(
      (await api.call('unpackOrder', { token, params: { saleId: shirt.saleId } })).status,
    ).toBe(404);
  });

  it("asks the seller's iPhone to read the labels of orders that need one", async () => {
    await api.db
      .insertInto('marketplace_connection')
      .values({
        account_id: tenant.accountId,
        marketplace: 'depop',
        mode: 'automation',
        status: 'connected',
        token_ciphertext: Buffer.from('sealed'),
        runs_on: 'phone',
      })
      .execute();
    const unread = await order({ title: 'Unread Depop order' });
    const refreshed = await api.call('refreshPackLabels', { token });
    expect(refreshed.body).toMatchObject({ marketplaces: ['depop'] });
    expect(refreshed.body.orders).toBeGreaterThan(0);
    const work = await api.db
      .selectFrom('phone_work')
      .select('purpose')
      .where('account_id', '=', tenant.accountId)
      .where('marketplace', '=', 'depop')
      .execute();
    expect(work).toEqual([{ purpose: 'label_read' }]);
    const listed = await api.call('listPackOrders', { token });
    expect(listed.body.data.find((entry) => entry.saleId === unread.saleId)?.labelStatus).toEqual({
      tone: 'neutral',
      label: 'Reading the label from Depop on your iPhone...',
    });
  });

  it("never shows or packs another account's order", async () => {
    const other = await api.tenantOf(OTHER);
    const theirs = await order({
      title: 'Not yours',
      tracking: '9400111899223197427777',
      accountId: other.accountId,
    });
    expect((await scan({ label: '9400111899223197427777', saleId: theirs.saleId })).status).toBe(
      404,
    );
    expect((await scan({ label: '9400111899223197427777' })).body.verdict).toBe('unknown_label');
    expect((await pack(theirs.saleId, { label: '9400111899223197427777' })).status).toBe(404);
    const listed = await api.call('listPackOrders', { token });
    expect(listed.body.data.some((entry) => entry.saleId === theirs.saleId)).toBe(false);
  });

  it('needs a label or a sticker to check', async () => {
    expect((await api.call('checkPackScan', { token, query: {} })).status).toBe(422);
  });
});

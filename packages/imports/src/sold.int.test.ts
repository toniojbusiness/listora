/**
 * Sold items for the sales history on real Postgres (docs/features/sales.md, "Sales history"):
 * a sale check's order of a listing Listora doesn't have, recorded by the worker's job
 * (`recordSaleOrder` with `soldItemMaker`), becomes a sold item made from the sold listing (its
 * photos from a local stand-in for the marketplace's image CDN, its details, and the listing on
 * its marketplace, sold), and the sale is recorded on it once. Without the listing, the order
 * line's title makes it; without either, nothing is recorded. It never joins an item Listora has.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  automationProfile,
  FAKE_MEDIA_PATH,
  fakeMediaPhoto,
  linkAutomationSession,
  orderEventPayload,
  recordSaleOrder,
} from '@listora/automation';
import { LocalTokenVault, SessionVault } from '@listora/connections';
import { createInventoryItem, jsonb, type Db, type JsonObject } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import type { ListedListing, RemoteOrder } from '@listora/marketplaces';
import type { PhotoJobPayload, PhotoJobQueue } from '@listora/photos';
import { createLogger } from '@listora/shared';
import { LocalDiskStorage } from '@listora/storage';

import { HttpImportPhotoFetcher } from './photos.ts';
import { soldItemMaker, SOLD_ITEM_PHOTOS, type SoldItemDependencies } from './sold.ts';

const logger = createLogger({ service: 'sold-items-test', level: 'silent' });
const DAY = 86_400_000;

describe('sold items for the sales history (real Postgres, a local image CDN)', () => {
  let database: MigratedDatabase;
  let db: Db;
  let server: Server;
  let cdn: string;
  let rootDir: string;
  let deps: SoldItemDependencies;
  let photoJobs: PhotoJobPayload[];
  let accountId: string;
  let connectionId: string;
  let order = 0;
  const vault = new SessionVault({ vault: new LocalTokenVault(randomBytes(32)), logger });

  beforeAll(async () => {
    database = await createMigratedDatabase('sold_items', { jobQueue: true, max: 8 });
    db = database.db;
    server = createServer((request, response) => {
      const name = FAKE_MEDIA_PATH.exec(new URL(request.url ?? '/', 'http://x').pathname)?.[1];
      if (name === undefined) {
        response.writeHead(404).end();
        return;
      }
      void fakeMediaPhoto(name).then((photo) => {
        response.writeHead(200, { 'content-type': 'image/jpeg' });
        response.end(photo);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cdn = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await database.close();
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
    rootDir = await mkdtemp(join(tmpdir(), 'listora-sold-items-'));
    photoJobs = [];
    const jobs: PhotoJobQueue = {
      enqueue: (_executor, job) => {
        photoJobs.push(job);
        return Promise.resolve();
      },
    };
    deps = {
      storage: new LocalDiskStorage({
        rootDir,
        baseUrl: 'http://127.0.0.1:3000',
        signingSecret: 'sold-items-test-secret-0123456789abcdef',
      }),
      photos: new HttpImportPhotoFetcher({ allowLocalHttp: true }),
      photoJobs: jobs,
      logger,
    };
    accountId = await insertAccount(db);
    const profile = automationProfile('depop');
    ({ connectionId } = await linkAutomationSession(
      db,
      { vault, profile },
      {
        accountId,
        marketplace: 'depop',
        runsOn: 'phone',
        cookies: [
          {
            name: 'session',
            value: 'signed-in',
            domain: profile.cookieDomains[0] ?? '.depop.com',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ],
      },
    ));
  });

  /** A sold listing as a Depop sale check reads it (invented). */
  function soldListing(slug: string, photos = 2): ListedListing {
    return {
      found: true,
      externalListingId: slug,
      externalUrl: `https://www.depop.com/products/${slug}/`,
      status: 'sold',
      title: null,
      description: 'Denim jacket\nLight wash, barely worn.',
      priceCents: 4500,
      currency: 'USD',
      revision: 1_761_000_000_000,
      refreshedAt: null,
      details: {
        photoUrls: Array.from(
          { length: photos },
          (_, index) => `${cdn}/media/${slug}-${String(index)}.jpg`,
        ),
        brand: 'Levi’s',
        size: 'M',
        condition: 'pre_owned_good',
        categoryRef: null,
        categoryPath: [],
        sku: null,
        colors: ['blue'],
        originalPriceCents: null,
      },
    };
  }

  /** Stores the order as a sale check does, and runs the worker's job for it (twice). */
  async function recordOrder(found: RemoteOrder): Promise<string> {
    order += 1;
    const event = await db
      .insertInto('inbound_event')
      .values({
        account_id: accountId,
        source: 'poll',
        marketplace: 'depop',
        provider_event_id: `order:${found.externalOrderId}:${String(order)}`,
        signature_ok: null,
        payload: jsonb(orderEventPayload(connectionId, found) as JsonObject),
        external_user_id: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const job = {
      db,
      adapters: () => undefined,
      logger,
      soldItems: soldItemMaker(deps),
    };
    for (let run = 0; run < 2; run += 1) {
      await recordSaleOrder(job, { accountId, inboundEventId: event.id });
    }
    return event.id;
  }

  const sales = () =>
    db
      .selectFrom('sale')
      .innerJoin('sale_item', 'sale_item.sale_id', 'sale.id')
      .innerJoin('inventory_item as item', 'item.id', 'sale_item.item_id')
      .leftJoin('marketplace_listing as listing', 'listing.id', 'sale_item.listing_id')
      .select([
        'sale.external_order_id',
        'sale.detection_source',
        'sale.status',
        'sale_item.sale_price_cents',
        'item.id as item_id',
        'item.title',
        'item.brand',
        'item.size_label',
        'item.condition',
        'item.status as item_status',
        'listing.status as listing_status',
        'listing.external_listing_id',
      ])
      .where('sale.account_id', '=', accountId)
      .orderBy('sale.sold_at')
      .execute();

  it('makes a sold item of a sale Listora had no listing for, with its photos and its sold listing', async () => {
    const event = await recordOrder({
      externalOrderId: '9100001',
      // Before Listora was connected: found in the sales history.
      soldAt: new Date(Date.now() - 30 * DAY),
      shipped: true,
      fees: [
        { kind: 'marketplace', description: "Depop's fees", amountCents: 410, currency: 'USD' },
      ],
      items: [
        {
          externalListingId: 'shop-denim-jacket-1',
          title: 'Denim jacket',
          priceCents: 3800,
          currency: 'USD',
          listing: soldListing('shop-denim-jacket-1', SOLD_ITEM_PHOTOS + 2),
        },
      ],
    });
    // Recorded once, though the job ran twice.
    expect(await sales()).toEqual([
      {
        external_order_id: '9100001',
        detection_source: 'history',
        // Depop said it shipped.
        status: 'shipped',
        sale_price_cents: 3800,
        item_id: expect.any(String) as unknown,
        title: 'Denim jacket',
        brand: 'Levi’s',
        size_label: 'M',
        condition: 'pre_owned_good',
        item_status: 'shipped',
        listing_status: 'sold',
        external_listing_id: 'shop-denim-jacket-1',
      },
    ]);
    const [sold] = await sales();
    const photos = await db
      .selectFrom('photo')
      .select(['position', 'role'])
      .where('item_id', '=', sold?.item_id ?? '')
      .orderBy('position')
      .execute();
    // The first few, cover first, each processed like any photo.
    expect(photos).toEqual(
      Array.from({ length: SOLD_ITEM_PHOTOS }, (_, position) => ({
        position,
        role: position === 0 ? 'front' : 'detail',
      })),
    );
    expect(photoJobs).toHaveLength(SOLD_ITEM_PHOTOS);
    // Depop's own fees, from the receipt, in place of the estimate.
    const fees = await db
      .selectFrom('fee_line')
      .innerJoin('sale', 'sale.id', 'fee_line.sale_id')
      .select(['fee_line.kind', 'fee_line.source', 'fee_line.amount_cents', 'fee_line.description'])
      .where('sale.external_order_id', '=', '9100001')
      .execute();
    expect(fees).toEqual([
      { kind: 'marketplace', source: 'actual', amount_cents: 410, description: "Depop's fees" },
    ]);
    const recorded = await db
      .selectFrom('inbound_event')
      .select('result')
      .where('id', '=', event)
      .executeTakeFirstOrThrow();
    expect(recorded.result).toBe('processed');
    // From the sales history: recorded only, no delist run at all.
    const runs = await db
      .selectFrom('delist_run')
      .select('status')
      .where('account_id', '=', accountId)
      .execute();
    expect(runs).toEqual([]);
  });

  it("makes it of the order line's title alone without the listing; of nothing, no sale", async () => {
    await recordOrder({
      externalOrderId: '9100002',
      soldAt: new Date(),
      items: [
        {
          externalListingId: 'shop-band-tee-2',
          title: 'Band tee',
          priceCents: 1500,
          currency: 'USD',
        },
      ],
    });
    const empty = await recordOrder({
      externalOrderId: '9100003',
      soldAt: new Date(),
      items: [{ externalListingId: null, title: null, priceCents: 900, currency: 'USD' }],
    });
    expect(await sales()).toMatchObject([
      {
        external_order_id: '9100002',
        // Since Listora was connected: found by the check, still to ship.
        detection_source: 'poll',
        status: 'detected',
        title: 'Band tee',
        brand: null,
        item_status: 'sold',
        listing_status: 'sold',
        external_listing_id: 'shop-band-tee-2',
      },
    ]);
    const ignored = await db
      .selectFrom('inbound_event')
      .select('result')
      .where('id', '=', empty)
      .executeTakeFirstOrThrow();
    expect(ignored.result).toBe('ignored');
  });

  it('never joins an item Listora has, even one that looks the same', async () => {
    const own = await createInventoryItem(db, accountId, {
      title: 'Denim jacket',
      brand: 'Levi’s',
    });
    await recordOrder({
      externalOrderId: '9100004',
      soldAt: new Date(Date.now() - DAY),
      items: [
        {
          externalListingId: 'shop-denim-jacket-4',
          title: 'Denim jacket',
          priceCents: 4000,
          currency: 'USD',
          listing: soldListing('shop-denim-jacket-4'),
        },
      ],
    });
    const [sold] = await sales();
    expect(sold?.item_id).not.toBe(own.id);
    const untouched = await db
      .selectFrom('inventory_item')
      .select('status')
      .where('id', '=', own.id)
      .executeTakeFirstOrThrow();
    expect(untouched.status).toBe('draft');
  });

  it("records the sale without photos when the marketplace's image CDN doesn't give them", async () => {
    const listing = soldListing('shop-silk-top-5');
    listing.details.photoUrls = [`${cdn}/not-an-image/5.jpg`];
    await recordOrder({
      externalOrderId: '9100005',
      soldAt: new Date(Date.now() - DAY),
      items: [
        {
          externalListingId: 'shop-silk-top-5',
          title: 'Silk top',
          priceCents: 2200,
          currency: 'USD',
          listing,
        },
      ],
    });
    expect(await sales()).toMatchObject([{ external_order_id: '9100005', sale_price_cents: 2200 }]);
    expect(photoJobs).toEqual([]);
  });
});

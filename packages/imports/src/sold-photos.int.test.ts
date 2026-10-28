/**
 * Photos for sold items that have none, on real Postgres (docs/features/sales.md, "Sales
 * history"): a check by an app built before sold items sent no sold listing, so its sales' sold
 * items have only a title. A later full read of the sales history (the migration's reset) that
 * shows each sold listing with its photos stores the order once more for its photos and queues
 * `automation_sold_item_photos`; the worker's job (`addSoldItemPhotos` with
 * `soldItemPhotoMaker`) fetches them from a local stand-in for the marketplace's image CDN and
 * adds them to the item, processed like any photo. An item with photos is never asked about, a
 * photo the CDN doesn't give leaves the item as it was, and the next check tries again.
 * Invented Mercari fixtures; no browser.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addSoldItemPhotos,
  automationProfile,
  FAKE_MEDIA_PATH,
  fakeMediaPhoto,
  linkAutomationSession,
  recordSaleOrder,
  runSaleCheck,
  SALE_ORDER_TASK,
  SOLD_ITEM_PHOTOS_TASK,
  type SaleOrderJobPayload,
  type SoldItemPhotosJobPayload,
} from '@listora/automation';
import { LocalTokenVault, SessionVault } from '@listora/connections';
import type { Db } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import type {
  ListedListing,
  MarketplaceAdapter,
  MarketplaceCapabilities,
  RemoteOrder,
} from '@listora/marketplaces';
import type { PhotoJobPayload, PhotoJobQueue } from '@listora/photos';
import { createLogger } from '@listora/shared';
import { LocalDiskStorage } from '@listora/storage';

import { HttpImportPhotoFetcher } from './photos.ts';
import {
  SOLD_ITEM_PHOTOS,
  soldItemMaker,
  soldItemPhotoMaker,
  type SoldItemDependencies,
} from './sold.ts';

const logger = createLogger({ service: 'sold-item-photos-test', level: 'silent' });
const DAY = 86_400_000;
const SETTINGS = {
  defaultIntervalMs: 12 * 3_600_000,
  minIntervalMs: 2 * 3_600_000,
  maxIntervalMs: 24 * 3_600_000,
  alertAfterFailures: 2,
  overdueMs: 6 * 3_600_000,
};

describe('sold item photos from a later sales history read (real Postgres, a local image CDN)', () => {
  let database: MigratedDatabase;
  let db: Db;
  let server: Server;
  let cdn: string;
  let rootDir: string;
  let deps: SoldItemDependencies;
  let photoJobs: PhotoJobPayload[];
  let accountId: string;
  let connectionId: string;
  /** What the stand-in Mercari adapter's next sale check reads. */
  let shown: RemoteOrder[] = [];
  const vault = new SessionVault({ vault: new LocalTokenVault(randomBytes(32)), logger });
  const adapter = {
    marketplace: 'mercari',
    capabilities: () => ({ saleDetection: ['poll'] }) as unknown as MarketplaceCapabilities,
    listOrdersSince: () => Promise.resolve(shown),
  } as unknown as MarketplaceAdapter;

  beforeAll(async () => {
    database = await createMigratedDatabase('sold_item_photos', { jobQueue: true, max: 8 });
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
    rootDir = await mkdtemp(join(tmpdir(), 'listora-sold-item-photos-'));
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
        signingSecret: 'sold-item-photos-test-secret-0123456789',
      }),
      photos: new HttpImportPhotoFetcher({ allowLocalHttp: true }),
      photoJobs: jobs,
      logger,
    };
    await sql`delete from graphile_worker._private_jobs`.execute(db);
    accountId = await insertAccount(db);
    const profile = automationProfile('mercari');
    ({ connectionId } = await linkAutomationSession(
      db,
      { vault, profile },
      {
        accountId,
        marketplace: 'mercari',
        runsOn: 'cloud',
        cookies: [
          {
            name: 'session',
            value: 'signed-in',
            domain: profile.cookieDomains[0] ?? '.mercari.com',
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

  /** A sold Mercari listing as a sale check reads it (invented), its photos on the local CDN. */
  function soldListing(id: string, photos: string[]): ListedListing {
    return {
      found: true,
      externalListingId: id,
      externalUrl: `https://www.mercari.com/us/item/${id}/`,
      status: 'sold',
      title: 'Wool scarf',
      description: 'Soft, grey.',
      priceCents: 1800,
      currency: 'USD',
      revision: 1_761_000_000_000,
      details: {
        photoUrls: photos.map((name) => `${cdn}/media/${name}.jpg`),
        brand: null,
        size: null,
        condition: 'pre_owned_good',
        categoryRef: null,
        categoryPath: [],
        sku: null,
        colors: [],
        originalPriceCents: null,
      },
    };
  }

  /** A Mercari order of one listing, sold `daysAgo` days ago, with its sold listing or not. */
  function order(id: string, daysAgo: number, listing?: ListedListing): RemoteOrder {
    return {
      externalOrderId: id,
      soldAt: new Date(Date.now() - daysAgo * DAY),
      shipped: true,
      items: [
        {
          externalListingId: id,
          title: 'Wool scarf',
          priceCents: 1800,
          currency: 'USD',
          ...(listing === undefined ? {} : { listing }),
        },
      ],
    };
  }

  /** A full sales history read (the migration's reset) that shows `orders`. */
  async function historyRead(orders: RemoteOrder[]): Promise<void> {
    shown = orders;
    await db
      .updateTable('sale_check_schedule')
      .set({ checked_through: null })
      .where('connection_id', '=', connectionId)
      .execute();
    await runSaleCheck(
      { db, adapters: () => adapter, settings: SETTINGS, logger },
      { accountId, connectionId },
      new AbortController().signal,
    );
  }

  async function queued<T>(task: string): Promise<T[]> {
    const { rows } = await sql<{ payload: T }>`
      select payload from graphile_worker._private_jobs where task_id =
        (select id from graphile_worker._private_tasks where identifier = ${task})
    `.execute(db);
    return rows.map((row) => row.payload);
  }

  /** Runs the queued jobs of both tasks as the worker does (each twice), and clears them. */
  async function runJobs(): Promise<void> {
    const soldItems = soldItemMaker(deps);
    const photos = soldItemPhotoMaker(deps);
    for (const payload of await queued<SaleOrderJobPayload>(SALE_ORDER_TASK)) {
      await recordSaleOrder({ db, adapters: () => undefined, logger, soldItems }, payload);
    }
    for (const payload of await queued<SoldItemPhotosJobPayload>(SOLD_ITEM_PHOTOS_TASK)) {
      for (let run = 0; run < 2; run += 1) {
        await addSoldItemPhotos({ db, logger, photos }, payload);
      }
    }
    await sql`delete from graphile_worker._private_jobs`.execute(db);
  }

  /** Each sale's order id and how many photos its item has. */
  const photoCounts = async () =>
    db
      .selectFrom('sale')
      .innerJoin('sale_item', 'sale_item.sale_id', 'sale.id')
      .select((eb) => [
        'sale.external_order_id',
        eb
          .selectFrom('photo')
          .select(sql<number>`count(*)::int`.as('count'))
          .whereRef('photo.item_id', '=', 'sale_item.item_id')
          .as('photos'),
      ])
      .where('sale.account_id', '=', accountId)
      .orderBy('sale.external_order_id')
      .execute();

  const photoEvents = () =>
    db
      .selectFrom('inbound_event')
      .select(['provider_event_id', 'result'])
      .where('account_id', '=', accountId)
      .where('provider_event_id', 'like', 'photos:%')
      .orderBy('created_at')
      .execute();

  it("adds the sold listing's photos to a sold item made without them, once", async () => {
    // An older app's check: no sold listing, so a sold item with the title only. The other
    // order came with its listing and has its photos already.
    await historyRead([
      order('m100000001', 30),
      order('m100000002', 20, soldListing('m100000002', ['scarf-2a'])),
    ]);
    await runJobs();
    expect(await photoCounts()).toEqual([
      { external_order_id: 'm100000001', photos: 0 },
      { external_order_id: 'm100000002', photos: 1 },
    ]);
    photoJobs = [];

    // The updated app's full read shows both sold listings with their photos.
    const read = () =>
      historyRead([
        order(
          'm100000001',
          30,
          soldListing(
            'm100000001',
            Array.from({ length: SOLD_ITEM_PHOTOS + 2 }, (_, index) => `scarf-1-${String(index)}`),
          ),
        ),
        order('m100000002', 20, soldListing('m100000002', ['scarf-2a', 'scarf-2b'])),
      ]);
    await read();
    // Only the item without photos is asked about; no sale is handed over again.
    expect(await queued(SALE_ORDER_TASK)).toEqual([]);
    expect(await queued(SOLD_ITEM_PHOTOS_TASK)).toHaveLength(1);
    await runJobs();
    // The first few, cover first, each processed like any photo (its thumbnail and listing
    // size), though the job ran twice.
    expect(await photoCounts()).toEqual([
      { external_order_id: 'm100000001', photos: SOLD_ITEM_PHOTOS },
      { external_order_id: 'm100000002', photos: 1 },
    ]);
    expect(photoJobs).toHaveLength(SOLD_ITEM_PHOTOS);
    const roles = await db
      .selectFrom('photo')
      .innerJoin('sale_item', 'sale_item.item_id', 'photo.item_id')
      .innerJoin('sale', 'sale.id', 'sale_item.sale_id')
      .select(['photo.position', 'photo.role'])
      .where('sale.external_order_id', '=', 'm100000001')
      .orderBy('photo.position')
      .execute();
    expect(roles[0]).toEqual({ position: 0, role: 'front' });
    expect((await photoEvents()).map((event) => event.result)).toEqual(['processed']);

    // A later read asks about nothing: every item has its photos.
    await read();
    expect(await queued(SOLD_ITEM_PHOTOS_TASK)).toEqual([]);
    expect(await photoEvents()).toHaveLength(1);
  });

  it("leaves the item as it was when the CDN doesn't give the photos, and tries again next check", async () => {
    await historyRead([order('m100000003', 10)]);
    await runJobs();
    const missing = soldListing('m100000003', []);
    missing.details.photoUrls = [`${cdn}/not-an-image/3.jpg`];
    await historyRead([order('m100000003', 10, missing)]);
    await runJobs();
    expect(await photoCounts()).toEqual([{ external_order_id: 'm100000003', photos: 0 }]);
    expect(photoJobs).toEqual([]);
    expect((await photoEvents()).map((event) => event.result)).toEqual(['ignored']);

    // The next check's read shows a photo the CDN gives.
    await historyRead([order('m100000003', 10, soldListing('m100000003', ['scarf-3']))]);
    await runJobs();
    expect(await photoCounts()).toEqual([{ external_order_id: 'm100000003', photos: 1 }]);
    expect((await photoEvents()).map((event) => event.result)).toEqual(['ignored', 'processed']);
  });

  it('never adds photos to an item that got some meanwhile', async () => {
    await historyRead([order('m100000004', 5)]);
    await runJobs();
    await historyRead([order('m100000004', 5, soldListing('m100000004', ['scarf-4']))]);
    // The seller added a photo before the worker's job ran.
    const [sale] = await db
      .selectFrom('sale_item')
      .select('item_id')
      .where('account_id', '=', accountId)
      .execute();
    await db
      .insertInto('photo')
      .values({
        account_id: accountId,
        item_id: sale?.item_id ?? '',
        position: 0,
        role: 'front',
        storage_key: `uploads/${accountId}/own.jpg`,
      })
      .execute();
    await runJobs();
    expect(await photoCounts()).toEqual([{ external_order_id: 'm100000004', photos: 1 }]);
    expect(photoJobs).toEqual([]);
    expect((await photoEvents()).map((event) => event.result)).toEqual(['ignored']);
  });
});

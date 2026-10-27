/**
 * Settling an import's listings on real Postgres (docs/features/imports.md): each listing becomes
 * an item listed there with its photos (fetched from a local stand-in for the marketplace's image
 * CDN), or is added to the item it is the same as, by its SKU line or its title and photos, or
 * becomes a question the seller answers; a listing Listora has is left as it is, and one whose
 * photos can't be fetched fails visibly. Two imports settling at once never make two items of one.
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
  automationProfile,
  FAKE_MEDIA_PATH,
  fakeMediaPhoto,
  linkAutomationSession,
} from '@listora/automation';
import { LocalTokenVault, SessionVault } from '@listora/connections';
import { jsonb, type Db, type JsonObject, type Marketplace } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import type { ListedListing } from '@listora/marketplaces';
import type { PhotoJobPayload, PhotoJobQueue } from '@listora/photos';
import { createLogger } from '@listora/shared';
import { LocalDiskStorage } from '@listora/storage';

import { applyListingImport, type ImportApplyDependencies } from './apply.ts';
import { HttpImportPhotoFetcher } from './photos.ts';
import { answerImportQuestion } from './resolve.ts';
import { importWords } from './summary.ts';

const logger = createLogger({ service: 'imports-test', level: 'silent' });

describe('settling an import (real Postgres, a local image CDN)', () => {
  let database: MigratedDatabase;
  let db: Db;
  let server: Server;
  let cdn: string;
  let rootDir: string;
  let deps: ImportApplyDependencies;
  let photoJobs: PhotoJobPayload[];
  let accountId: string;
  let userId: string;
  const vault = new SessionVault({ vault: new LocalTokenVault(randomBytes(32)), logger });

  beforeAll(async () => {
    database = await createMigratedDatabase('imports', { jobQueue: true, max: 8 });
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
    rootDir = await mkdtemp(join(tmpdir(), 'listora-imports-'));
    photoJobs = [];
    const jobs: PhotoJobQueue = {
      enqueue: (_executor, job) => {
        photoJobs.push(job);
        return Promise.resolve();
      },
    };
    deps = {
      db,
      storage: new LocalDiskStorage({
        rootDir,
        baseUrl: 'http://127.0.0.1:3000',
        signingSecret: 'imports-test-secret-0123456789abcdefgh',
      }),
      photos: new HttpImportPhotoFetcher({ allowLocalHttp: true }),
      photoJobs: jobs,
      logger,
    };
    accountId = await insertAccount(db);
    ({ id: userId } = await db
      .insertInto('app_user')
      .values({ auth_provider: 'dev', auth_subject: `imports-${accountId}` })
      .returning('id')
      .executeTakeFirstOrThrow());
  });

  async function link(marketplace: Marketplace): Promise<string> {
    const profile = automationProfile(marketplace);
    const domain = profile.cookieDomains[0] ?? '.example.com';
    const { connectionId } = await linkAutomationSession(
      db,
      { vault, profile },
      {
        accountId,
        marketplace,
        runsOn: 'cloud',
        cookies: [
          {
            name: 'session',
            value: 'signed-in',
            domain,
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ],
      },
    );
    return connectionId;
  }

  function listing(
    id: string,
    overrides: Partial<ListedListing> = {},
    details: Partial<ListedListing['details']> = {},
  ): ListedListing {
    return {
      found: true,
      externalListingId: id,
      externalUrl: `https://marketplace.test/${id}`,
      status: 'active',
      title: 'Floral maxi dress',
      description: 'Worn once. Fits like a small.',
      priceCents: 3400,
      currency: 'USD',
      revision: 1_761_000_000_000,
      ...overrides,
      details: {
        photoUrls: [`${cdn}/media/${id}-front.jpg`, `${cdn}/media/${id}-back.jpg`],
        brand: 'Free People',
        size: 'S',
        condition: 'pre_owned_excellent',
        categoryRef: null,
        categoryPath: [],
        sku: null,
        ...details,
      },
    };
  }

  /** An import of `listings` on `marketplace` whose pages are all read. */
  async function imported(marketplace: Marketplace, listings: ListedListing[]): Promise<string> {
    const connectionId = await link(marketplace);
    const { id } = await db
      .insertInto('listing_import')
      .values({
        account_id: accountId,
        connection_id: connectionId,
        marketplace,
        host: 'runner',
        status: 'importing',
        read_at: new Date(),
        pages_read: 1,
        listings_read: listings.length,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const read of listings) {
      await db
        .insertInto('listing_import_entry')
        .values({
          account_id: accountId,
          import_id: id,
          marketplace,
          external_listing_id: read.externalListingId,
          listing: jsonb(JSON.parse(JSON.stringify(read)) as JsonObject),
        })
        .execute();
    }
    return id;
  }

  async function settled(importId: string) {
    await applyListingImport(deps, { accountId, importId });
    const row = await db
      .selectFrom('listing_import')
      .selectAll()
      .where('id', '=', importId)
      .executeTakeFirstOrThrow();
    const entries = await db
      .selectFrom('listing_import_entry')
      .selectAll()
      .where('import_id', '=', importId)
      .orderBy('external_listing_id')
      .execute();
    return { row, entries };
  }

  async function items() {
    return db
      .selectFrom('inventory_item')
      .selectAll()
      .where('account_id', '=', accountId)
      .execute();
  }

  async function listingsOf(itemId: string) {
    return db
      .selectFrom('marketplace_listing')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('item_id', '=', itemId)
      .orderBy('marketplace')
      .execute();
  }

  it('imports each listing as an item already listed there, with its photos and details', async () => {
    const importId = await imported('depop', [
      listing(
        'dress-1',
        { title: null, description: 'Floral maxi dress, worn once.\nFits like a small.' },
        {
          categoryRef: 'Women > Dresses > Casual dresses',
          categoryPath: ['Women', 'Dresses', 'Casual dresses'],
        },
      ),
    ]);
    const { row, entries } = await settled(importId);
    expect(row).toMatchObject({
      status: 'finished',
      imported: 1,
      merged: 0,
      needs_you: 0,
      failed: 0,
    });
    expect(importWords(row)).toEqual({ progress: 'Done', summary: 'Imported 1 from Depop' });
    const [item] = await items();
    expect(item).toMatchObject({
      status: 'listed',
      title: 'Floral maxi dress, worn once.',
      description: 'Floral maxi dress, worn once.\nFits like a small.',
      brand: 'Free People',
      category: 'clothing/dresses/dresses',
      department: 'women',
      size_label: 'S',
      size_system: 'letter',
      condition: 'pre_owned_excellent',
      list_price_cents: 3400,
    });
    expect(item?.field_provenance).toMatchObject({
      title: 'marketplace',
      listPrice: 'marketplace',
    });
    expect(entries).toMatchObject([{ outcome: 'imported', item_id: item?.id }]);
    const photos = await db
      .selectFrom('photo')
      .selectAll()
      .where('item_id', '=', item?.id ?? '')
      .orderBy('position')
      .execute();
    expect(photos.map((photo) => [photo.position, photo.role, photo.status])).toEqual([
      [0, 'front', 'processing'],
      [1, 'detail', 'processing'],
    ]);
    expect(photos.every((photo) => photo.width === 256 && photo.phash !== null)).toBe(true);
    expect(photoJobs.map((job) => job.photoId).sort()).toEqual(
      photos.map((photo) => photo.id).sort(),
    );
    expect(await deps.storage.get(photos[0]?.storage_key ?? '')).toBeDefined();
    const [listed] = await listingsOf(item?.id ?? '');
    expect(listed).toMatchObject({
      marketplace: 'depop',
      status: 'active',
      external_listing_id: 'dress-1',
      external_url: 'https://marketplace.test/dress-1',
      price_cents: 3400,
      category_ref: 'Women > Dresses > Casual dresses',
      remote_revision: 1_761_000_000_000,
    });
    // The import's read is the listing's read-back.
    expect(listed?.last_verified_at).toBeInstanceOf(Date);
    expect(listed?.remote_snapshot).toMatchObject({
      externalListingId: 'dress-1',
      status: 'active',
    });
    const audit = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('item_id', '=', item?.id ?? '')
      .execute();
    expect(audit).toMatchObject([{ actor_kind: 'marketplace', action: 'item.imported' }]);
  });

  it('adds the same item on another marketplace to it, by its SKU line or its title and photos', async () => {
    await settled(
      await imported('depop', [listing('dress-1'), listing('scarf-1', { title: 'Wool scarf' })]),
    );
    const [dress] = (await items()).filter((item) => item.title === 'Floral maxi dress');
    // On Poshmark: the dress's own photo with a title that adds words, and a listing whose SKU
    // line names the scarf.
    const scarf = (await items()).find((item) => item.title === 'Wool scarf');
    const { row, entries } = await settled(
      await imported('poshmark', [
        listing(
          'posh-dress',
          { title: 'Free People floral maxi dress S' },
          {
            photoUrls: [`${cdn}/media/dress-1-front.jpg`],
          },
        ),
        listing(
          'posh-scarf',
          { title: 'Cozy knit' },
          { sku: scarf?.sku ?? '', photoUrls: [`${cdn}/media/other.jpg`] },
        ),
      ]),
    );
    expect(row).toMatchObject({ status: 'finished', imported: 0, merged: 2 });
    expect(importWords(row).summary).toBe('Imported 2 from Poshmark');
    expect(entries.map((entry) => [entry.external_listing_id, entry.outcome, entry.match])).toEqual(
      [
        ['posh-dress', 'merged', 'title_photos'],
        ['posh-scarf', 'merged', 'sku'],
      ],
    );
    expect(await items()).toHaveLength(2);
    expect((await listingsOf(dress?.id ?? '')).map((found) => found.marketplace)).toEqual([
      'depop',
      'poshmark',
    ]);
    // Merging adds the listing; the item keeps its own details and photos.
    const [after] = (await items()).filter((item) => item.id === dress?.id);
    expect(after?.title).toBe('Floral maxi dress');
  });

  it("asks when unsure, and settles each question by the seller's answer", async () => {
    await settled(
      await imported('depop', [
        listing('dress-1'),
        listing('dress-2', { title: 'Linen shirt dress' }),
      ]),
    );
    const [dress] = (await items()).filter((item) => item.title === 'Floral maxi dress');
    const importId = await imported('mercari', [
      // The dress's photo, another title: maybe the dress.
      listing(
        'm-1',
        { title: 'Summer sundress' },
        { photoUrls: [`${cdn}/media/dress-1-front.jpg`] },
      ),
      listing('m-2', { title: 'Beach cover up' }, { photoUrls: [`${cdn}/media/dress-1-back.jpg`] }),
      listing(
        'm-3',
        { title: 'Garden party frock' },
        { photoUrls: [`${cdn}/media/dress-1-front.jpg`] },
      ),
    ]);
    const first = await settled(importId);
    expect(first.row).toMatchObject({ status: 'finished', needs_you: 3 });
    expect(importWords(first.row).summary).toBe('Imported 0 from Mercari, 3 need you');
    const [same, different, skipped] = first.entries;
    expect(same?.candidates).toEqual([{ itemId: dress?.id, reason: 'photo' }]);

    const question = (entryId: string) => ({ accountId, userId, importId, entryId });
    await answerImportQuestion(db, question(same?.id ?? ''), {
      answer: 'same_item',
      itemId: dress?.id ?? '',
    });
    await answerImportQuestion(db, question(skipped?.id ?? ''), { answer: 'skip' });
    await answerImportQuestion(db, question(different?.id ?? ''), { answer: 'new_item' });
    await expect(
      answerImportQuestion(db, question(skipped?.id ?? ''), { answer: 'skip' }),
    ).rejects.toThrow('already answered');
    // The new item is imported by the worker, with its photos.
    const second = await settled(importId);
    expect(second.row).toMatchObject({ status: 'finished', imported: 1, merged: 1, needs_you: 0 });
    expect(
      second.entries.map((entry) => [entry.external_listing_id, entry.outcome, entry.match]),
    ).toEqual([
      ['m-1', 'merged', 'seller'],
      ['m-2', 'imported', null],
      ['m-3', 'skipped', null],
    ]);
    expect((await listingsOf(dress?.id ?? '')).map((found) => found.marketplace)).toEqual([
      'depop',
      'mercari',
    ]);
    expect(await items()).toHaveLength(3);
  });

  it('leaves a listing Listora already has as it is, so importing again changes nothing', async () => {
    const listings = [listing('dress-1')];
    await settled(await imported('depop', listings));
    const before = await items();
    const { row, entries } = await settled(await imported('depop', listings));
    expect(row).toMatchObject({ status: 'finished', imported: 0, already_listed: 1 });
    expect(importWords(row).summary).toBe('Imported 0 from Depop, 1 already in Listora');
    expect(entries[0]?.item_id).toBe(before[0]?.id);
    expect(await items()).toHaveLength(1);
  });

  it("fails a listing whose photos can't be fetched, visibly, and imports the rest", async () => {
    const { row, entries } = await settled(
      await imported('depop', [
        listing('broken', {}, { photoUrls: [`${cdn}/missing/photo.jpg`] }),
        listing('fine', { title: 'Wool scarf' }),
      ]),
    );
    expect(row).toMatchObject({ status: 'finished', imported: 1, failed: 1 });
    expect(importWords(row).summary).toBe("Imported 1 from Depop, 1 couldn't be imported");
    expect(entries[0]).toMatchObject({
      outcome: 'failed',
      error_message:
        "Listora couldn't get this listing's photos from Depop. Import again to try again.",
    });
  });

  it('never makes two items of one item when two imports settle at once', async () => {
    const depop = await imported('depop', [listing('dress-1')]);
    const poshmark = await imported('poshmark', [
      listing('posh-dress', {}, { photoUrls: [`${cdn}/media/dress-1-front.jpg`] }),
    ]);
    await Promise.all([
      applyListingImport(deps, { accountId, importId: depop }),
      applyListingImport(deps, { accountId, importId: poshmark }),
    ]);
    const all = await items();
    expect(all).toHaveLength(1);
    expect((await listingsOf(all[0]?.id ?? '')).map((found) => found.marketplace).sort()).toEqual([
      'depop',
      'poshmark',
    ]);
    const counts = await sql<{ outcome: string }>`
      select outcome from listing_import_entry where account_id = ${accountId} order by outcome
    `.execute(db);
    expect(counts.rows.map((entry) => entry.outcome)).toEqual(['imported', 'merged']);
  });
});

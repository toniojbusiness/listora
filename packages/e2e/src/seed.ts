/**
 * Setting up the stack's signed-in user through the API, exactly as the app would: connecting
 * eBay through the fake eBay's consent page, and creating an item with processed photos. Each
 * step goes through the real endpoints, so a broken flow fails the stack instead of being
 * papered over.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { Db, Marketplace } from '@listora/db';
import type { FakeEbay } from '@listora/marketplaces';
import sharp from 'sharp';

export interface StackApi {
  readonly apiUrl: string;
  readonly accessToken: string;
}

async function call<T>(
  api: StackApi,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${api.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${api.accessToken}`,
      ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with ${String(response.status)}: ${text}`);
  }
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

/**
 * Connects the user's eBay account as the app does: start the authorization, agree on the fake
 * eBay's consent page, and follow its redirect to the API's callback. Fails unless the server
 * then reports the connection as connected.
 */
export async function connectEbay(api: StackApi, fake: FakeEbay): Promise<void> {
  const attempt = await call<{ id: string; authorizationUrl?: string }>(
    api,
    'POST',
    '/v1/connections/ebay/authorizations',
  );
  if (attempt.authorizationUrl === undefined) {
    throw new Error('eBay cannot be connected: the API has no eBay OAuth client or token vault');
  }
  const callback = new URL(fake.consent(attempt.authorizationUrl));
  const redirected = await fetch(`${api.apiUrl}${callback.pathname}${callback.search}`, {
    redirect: 'manual',
  });
  if (redirected.status !== 302) {
    throw new Error(`the eBay callback answered ${String(redirected.status)}, not a redirect`);
  }
  const result = await call<{ status: string; connection?: { status: string } }>(
    api,
    'GET',
    `/v1/connections/ebay/authorizations/${attempt.id}`,
  );
  if (result.status !== 'completed' || result.connection?.status !== 'connected') {
    throw new Error(`connecting eBay ended ${result.status}`);
  }
}

export interface SeededItem {
  id: string;
  sku: string;
}

/** The details of an item every marketplace adapter can list (eBay maps its category). */
export const READY_ITEM_DETAILS = {
  title: "Levi's Trucker Denim Jacket",
  description: 'Classic trucker jacket in medium wash. Light fading at the cuffs.',
  brand: "Levi's",
  department: 'men',
  category: 'clothing/outerwear/denim_jackets',
  sizeLabel: 'M',
  sizeSystem: 'letter',
  colors: ['blue'],
  condition: 'pre_owned_excellent',
  listPrice: { amountCents: 4500, currency: 'USD' },
  cost: { amountCents: 800, currency: 'USD' },
  purchaseSource: 'Goodwill',
} as const;

/**
 * Creates a `ready` item with two photos and waits until the worker has processed them, so it
 * can be listed at once. `details` replaces the defaults key by key.
 */
export async function createReadyItem(
  api: StackApi,
  details: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<SeededItem> {
  const item = await call<{ id: string; sku: string; version: number }>(api, 'POST', '/v1/items', {
    details: { ...READY_ITEM_DETAILS, ...details },
  });
  const photos = await Promise.all([jpeg(70), jpeg(150)]);
  const session = await call<{
    files: { id: string; upload?: { url: string; headers: { name: string; value: string }[] } }[];
  }>(api, 'POST', '/v1/upload-sessions', {
    files: photos.map((bytes) => ({
      contentType: 'image/jpeg',
      byteSize: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  });
  for (const [index, file] of session.files.entries()) {
    const bytes = photos[index];
    if (file.upload === undefined || bytes === undefined) throw new Error('no upload target');
    const uploaded = await fetch(file.upload.url, {
      method: 'PUT',
      headers: Object.fromEntries(file.upload.headers.map(({ name, value }) => [name, value])),
      body: bytes,
    });
    if (!uploaded.ok) throw new Error(`uploading a photo failed with ${String(uploaded.status)}`);
    await call(api, 'POST', `/v1/items/${item.id}/photos`, {
      uploadFileId: file.id,
      role: index === 0 ? 'front' : 'back',
      width: 800,
      height: 600,
    });
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await call<{ photos: { status: string }[] }>(
      api,
      'GET',
      `/v1/items/${item.id}`,
    );
    if (
      current.photos.length === photos.length &&
      current.photos.every((p) => p.status === 'ready')
    ) {
      break;
    }
    if (current.photos.some((photo) => photo.status === 'failed')) {
      throw new Error('a seeded photo failed to process');
    }
    if (Date.now() > deadline) throw new Error('the seeded photos were not processed in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Saved as the review flow saves it: ready to list.
  const latest = await call<{ version: number; details: Record<string, unknown> }>(
    api,
    'GET',
    `/v1/items/${item.id}`,
  );
  const ready = await fetch(`${api.apiUrl}/v1/items/${item.id}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${api.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedVersion: latest.version,
      status: 'ready',
      details: latest.details,
    }),
  });
  if (!ready.ok)
    throw new Error(`marking the seeded item ready failed with ${String(ready.status)}`);
  return { id: item.id, sku: item.sku };
}

export interface SeededListedItem extends SeededItem {
  /** The item's first listing (its eBay listing unless eBay was not asked for). */
  listingId: string;
  /** Each marketplace's listing, confirmed active there. */
  listings: Partial<Record<Marketplace, string>>;
}

/**
 * A ready item (`createReadyItem`) published on each marketplace through the API and the
 * worker, as the listing flow publishes it; unless `wait` is false, waits until every
 * marketplace confirmed it active (by read-back). A marketplace that runs on the phone confirms
 * only once the app has run its publish.
 */
export async function createListedItem(
  api: StackApi,
  details: Record<string, unknown> = {},
  marketplaces: readonly Marketplace[] = ['ebay'],
  options: { wait?: boolean; timeoutMs?: number } = {},
): Promise<SeededListedItem> {
  const timeoutMs = options.timeoutMs ?? 240_000;
  const item = await createReadyItem(api, details);
  const merged = { ...READY_ITEM_DETAILS, ...details };
  const listed = await Promise.all(
    marketplaces.map(async (marketplace) => {
      const listing = await call<{ id: string }>(api, 'POST', `/v1/items/${item.id}/listings`, {
        marketplace,
        variant: {
          title: merged.title,
          description: merged.description,
          price: merged.listPrice,
        },
      });
      await call(api, 'POST', `/v1/listings/${listing.id}/publish`);
      return [marketplace, listing.id] as const;
    }),
  );
  const deadline = Date.now() + timeoutMs;
  for (const [marketplace, listingId] of options.wait === false ? [] : listed) {
    for (;;) {
      const current = await call<{ latestOperation?: { status: string; error?: unknown } }>(
        api,
        'GET',
        `/v1/listings/${listingId}`,
      );
      const status = current.latestOperation?.status;
      if (status === 'succeeded') break;
      if (status === 'failed' || status === 'needs_user_action') {
        throw new Error(
          `publishing the seeded item on ${marketplace} ended ${status}: ${JSON.stringify(current.latestOperation)}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(`the seeded item was not published on ${marketplace} in time`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const listings = Object.fromEntries(listed) as Partial<Record<Marketplace, string>>;
  const first = listed[0];
  if (first === undefined) throw new Error('no marketplace to list on');
  return { ...item, listingId: first[1], listings };
}

/**
 * A ready item with a Depop listing that is being published: the publish is only queued, for
 * the phone that runs Depop to take (docs/features/phone-execution.md), so nothing waits for it.
 */
export async function createQueuedDepopListing(
  api: StackApi,
  details: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<SeededListedItem> {
  const item = await createReadyItem(api, details, timeoutMs);
  const merged = { ...READY_ITEM_DETAILS, ...details };
  const listing = await call<{ id: string }>(api, 'POST', `/v1/items/${item.id}/listings`, {
    marketplace: 'depop',
    variant: {
      title: merged.title,
      description: merged.description,
      price: merged.listPrice,
    },
  });
  await call(api, 'POST', `/v1/listings/${listing.id}/publish`);
  return { ...item, listingId: listing.id, listings: { depop: listing.id } };
}

/** An 800 x 600 JPEG of one color. */
async function jpeg(red: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: red, g: 90, b: 140 } },
    })
      .jpeg({ quality: 80 })
      .toBuffer(),
  );
}

/**
 * Records a sale of `item` on eBay an hour ago, shipping by tomorrow, with the item kept in bin
 * `B-12`: what a Today "ship" card shows. Written to the database directly, standing in for an
 * eBay order notification (a seller's own "Mark as sold" has no ship-by date or bin); the item
 * is `sold`, as it is once a sale's delist run (here: nothing else to delist) completes.
 */
export async function recordSoldItem(
  db: Db,
  item: SeededItem,
): Promise<SeededItem & { saleId: string; saleItemId: string }> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('inventory_item')
      .select(['account_id', 'list_price_cents'])
      .where('id', '=', item.id)
      .executeTakeFirstOrThrow();
    const location = await trx
      .insertInto('storage_location')
      .values({ account_id: row.account_id, code: 'B-12', label: 'Garage shelf 3' })
      .onConflict((conflict) =>
        conflict.columns(['account_id', 'code']).doUpdateSet({ label: 'Garage shelf 3' }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('inventory_item')
      .set({ status: 'sold', storage_location_id: location.id })
      .where('id', '=', item.id)
      .execute();
    const now = Date.now();
    const sale = await trx
      .insertInto('sale')
      .values({
        account_id: row.account_id,
        marketplace: 'ebay',
        external_order_id: `e2e-${randomUUID()}`,
        sold_at: new Date(now - 60 * 60_000),
        ship_by: new Date(now + 24 * 60 * 60_000),
        detection_source: 'webhook',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const line = await trx
      .insertInto('sale_item')
      .values({
        account_id: row.account_id,
        sale_id: sale.id,
        marketplace: 'ebay',
        item_id: item.id,
        sale_price_cents: row.list_price_cents ?? 4500,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { ...item, saleId: sale.id, saleItemId: line.id };
  });
}

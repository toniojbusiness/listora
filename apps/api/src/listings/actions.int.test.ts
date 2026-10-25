/**
 * The listing actions end to end: the API queues each change, a real operation worker runs it
 * with the eBay adapter against the fake eBay, and the API shows the listing as done only once
 * the engine verified it on eBay. Failures stay visible with a Retry that works.
 */
import { jsonb } from '@listora/db';
import { createLogger } from '@listora/shared';
import {
  createMarketplaceAdapters,
  FakeEbay,
  loadEbayConfig,
  type EbayConfig,
} from '@listora/marketplaces';
import { startOperationWorker, type OperationWorker, type RetryPolicy } from '@listora/operations';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Tenant } from '../tenancy.ts';
import { findListing } from './repository.ts';
import { listingStates } from './views.ts';
import { createTestApi, fieldsOf, type SuccessBody, type TestApi } from '../test-support.ts';

const OWNER = 'listing.owner@example.com';
const STRANGER = 'listing.stranger@example.com';
const UNCONNECTED = 'listing.unconnected@example.com';

/** Seven attempts milliseconds apart: eBay's double read-back confirms in a blink. */
const FAST_POLICY: RetryPolicy = {
  delaysMs: [20, 30, 40, 50, 60, 70],
  jitter: 0,
  random: () => 0.5,
};

const DETAILS = {
  title: "Levi's Trucker Denim Jacket",
  description: 'Classic trucker jacket in medium wash.',
  brand: "Levi's",
  department: 'men',
  category: 'clothing/outerwear/denim_jackets',
  sizeLabel: 'M',
  sizeSystem: 'letter',
  colors: ['blue'],
  condition: 'pre_owned_excellent',
  listPrice: { amountCents: 4500, currency: 'USD' },
  cost: { amountCents: 800, currency: 'USD' },
} as const;

const VARIANT = {
  title: "Levi's Trucker Denim Jacket Men's M Blue",
  description: 'Classic trucker jacket in medium wash. Light fading at the cuffs.',
  price: { amountCents: 4500, currency: 'USD' },
} as const;

async function jpeg(seed: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: seed % 256, g: 90, b: 60 } },
    })
      .jpeg({ quality: 80 })
      .toBuffer(),
  );
}

describe('listing actions through the operation engine and the fake eBay (real Postgres)', () => {
  let fake: FakeEbay;
  let api: TestApi;
  let worker: OperationWorker | undefined;
  let token: string;
  let tenant: Tenant;
  let seed = 0;

  beforeAll(async () => {
    fake = await FakeEbay.start({ allowHttpPictures: true });
    const apiConfig = ebayConfig({});
    api = await createTestApi('listing_actions', {
      connections: {
        adapters: createMarketplaceAdapters({
          fakeMarketplaceUrl: undefined,
          ebay: apiConfig,
          depop: undefined,
        }),
        oauth: {},
        sealer: undefined,
      },
    });
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
    // The account's eBay connection, bound to the fake's development seller.
    const connection = await api.db
      .insertInto('marketplace_connection')
      .values({
        account_id: tenant.accountId,
        marketplace: 'ebay',
        mode: 'api',
        external_user_id: 'listora_dev_seller',
        display_name: 'listora_dev_seller',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const workerAdapters = createMarketplaceAdapters({
      fakeMarketplaceUrl: undefined,
      ebay: ebayConfig({ EBAY_USER_CONNECTION_ID: connection.id }),
      depop: undefined,
    });
    worker = await startOperationWorker({
      connectionString: api.databaseUrl,
      db: api.db,
      adapters: workerAdapters.lookup,
      logger: createLogger({ service: 'listing-actions-test', level: 'silent' }),
      policy: FAST_POLICY,
      pollIntervalMs: 20,
      onFatalError: (error) => {
        throw error;
      },
    });
  });

  afterAll(async () => {
    await worker?.stop();
    await api.close();
    await fake.close();
  });

  function ebayConfig(extra: Record<string, string>): EbayConfig {
    const config = loadEbayConfig({ EBAY_ENV: 'fake', EBAY_FAKE_URL: fake.url, ...extra });
    if (config === undefined) throw new Error('no eBay configuration');
    return config;
  }

  /** A ready-to-list item with two processed photos. */
  async function readyItem(as = token, owner = tenant): Promise<SuccessBody<'createItem'>> {
    const created = await api.call('createItem', { token: as, body: { details: DETAILS } });
    expect(created.status).toBe(201);
    for (const role of ['front', 'back'] as const) {
      seed += 1;
      const uploadFileId = await api.uploads.add(owner, { bytes: await jpeg(seed) });
      const added = await api.call('addItemPhoto', {
        token: as,
        params: { itemId: created.body.id },
        body: { uploadFileId, role, width: 640, height: 480 },
      });
      expect(added.status).toBe(201);
    }
    await api.photoJobs.runAll();
    return created.body;
  }

  async function draftListing(itemId: string, variant: object = VARIANT) {
    const created = await api.call('createListing', {
      token,
      params: { itemId },
      body: { marketplace: 'ebay', variant },
    });
    expect(created.status).toBe(201);
    return created.body;
  }

  /** Waits until the listing's newest operation has settled, then returns the listing. */
  async function settled(listingId: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const listing = await api.call('getListing', { token, params: { listingId } });
      expect(listing.status).toBe(200);
      const status = listing.body.latestOperation?.status;
      if (status === 'succeeded' || status === 'failed' || status === 'needs_user_action') {
        return listing.body;
      }
      if (Date.now() > deadline) {
        throw new Error(`listing ${listingId} still shows ${listing.body.statusDisplay.label}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const item = (itemId: string) => api.call('getItem', { token, params: { itemId } });

  it('refuses an eBay listing until the account has connected eBay', async () => {
    const otherToken = await api.signIn(UNCONNECTED);
    const created = await api.call('createItem', { token: otherToken, body: { details: DETAILS } });
    const response = await api.call('createListing', {
      token: otherToken,
      params: { itemId: created.body.id },
      body: { marketplace: 'ebay', variant: VARIANT },
    });
    expect(response.status).toBe(409);
    expect(response.error).toMatchObject({
      code: 'marketplace_not_connected',
      message: 'Connect your eBay account first, in Settings > Marketplaces.',
    });
  });

  it('publishes, changes the price, fails a delist visibly, retries it, and relists', async () => {
    const ready = await readyItem();
    const draft = await draftListing(ready.id);
    expect(draft).toMatchObject({
      marketplace: 'ebay',
      mode: 'api',
      status: 'draft',
      statusDisplay: { tone: 'neutral', label: 'Draft' },
      variant: VARIANT,
      availableActions: [{ action: 'publish', mode: 'api' }],
    });

    // Publish: in progress until eBay shows the listing on two reads.
    const published = await api.call('publishListing', { token, params: { listingId: draft.id } });
    expect(published.status).toBe(202);
    expect(published.body.listing.statusDisplay).toEqual({
      tone: 'in_progress',
      label: 'Publishing...',
    });
    expect(published.body.listing.availableActions).toEqual([]);
    expect(published.body.operation).toMatchObject({ kind: 'create', status: 'queued' });
    const active = await settled(draft.id);
    expect(active).toMatchObject({
      status: 'active',
      statusDisplay: { tone: 'success', label: 'Active (confirmed by eBay)' },
      verification: { method: 'marketplace_api' },
      latestOperation: {
        kind: 'create',
        status: 'succeeded',
        statusDisplay: { label: 'Published (confirmed by eBay)' },
      },
    });
    expect(active.externalListingId).toMatch(/^\d{12}$/);
    expect(fake.listing(active.externalListingId ?? '')).toMatchObject({ status: 'Active' });
    expect((await item(ready.id)).body.status).toBe('listed');
    expect(active.availableActions.map((available) => available.action)).toEqual([
      'change_price',
      'revise',
      'end',
      'verify',
    ]);

    // A price change: eBay has the new price once confirmed.
    const repriced = await api.call('changeListingPrice', {
      token,
      params: { listingId: draft.id },
      body: { price: { amountCents: 3900, currency: 'USD' } },
    });
    expect(repriced.status).toBe(202);
    expect(repriced.body.listing.statusDisplay.label).toBe('Updating price...');
    const priced = await settled(draft.id);
    expect(priced.statusDisplay.label).toBe('Active (confirmed by eBay)');
    expect(priced.latestOperation?.statusDisplay.label).toBe('Price changed (confirmed by eBay)');
    expect(priced.variant?.price.amountCents).toBe(3900);

    // eBay refuses the end: the failure is visible, with a Retry.
    fake.inject({
      action: 'end',
      fault: { type: 'reject', message: 'The listing cannot be ended now.' },
    });
    const ending = await api.call('endListing', {
      token,
      params: { listingId: draft.id },
      body: { reason: 'not_available' },
    });
    expect(ending.status).toBe(202);
    expect(ending.body.listing.statusDisplay.label).toBe('Delisting...');
    const failed = await settled(draft.id);
    expect(failed.status).toBe('active');
    expect(failed.statusDisplay).toMatchObject({ tone: 'failed', label: 'Delist failed - Retry' });
    expect(failed.latestOperation).toMatchObject({
      kind: 'end',
      status: 'failed',
      error: { retryable: true },
    });
    expect(fake.listing(active.externalListingId ?? '')).toMatchObject({ status: 'Active' });
    // The seller can still act: a failed change never locks the listing.
    expect(failed.availableActions.map((available) => available.action)).toContain('end');

    // Retry: the same operation runs again and eBay ends the listing.
    const operationId = failed.latestOperation?.id ?? '';
    const retried = await api.call('retryOperation', { token, params: { operationId } });
    expect(retried.status).toBe(202);
    expect(retried.body).toMatchObject({ id: operationId, status: 'queued', attempt: 0 });
    const ended = await settled(draft.id);
    expect(ended).toMatchObject({
      status: 'ended',
      statusDisplay: { tone: 'success', label: 'Delisted (confirmed by eBay)' },
    });
    expect(fake.listing(active.externalListingId ?? '')).toMatchObject({ status: 'Ended' });
    expect((await item(ready.id)).body.status).toBe('ready');

    // The history keeps the failure and the retry.
    const events = await api.call('listOperationEvents', { token, params: { operationId } });
    const statuses = events.body.data.map((event) => event.toStatus);
    expect(statuses[0]).toBe('queued');
    expect(statuses).toContain('failed');
    expect(statuses.at(-1)).toBe('succeeded');
    expect(events.body.data.map((event) => event.sequence)).toEqual(
      events.body.data.map((_, index) => index + 1),
    );
    const failure = events.body.data.find((event) => event.toStatus === 'failed');
    expect(failure?.error?.retryable).toBe(true);
    expect(events.body.data.at(-1)?.message).toBe('eBay confirmed it.');

    // A retry of a settled operation is refused.
    const again = await api.call('retryOperation', { token, params: { operationId } });
    expect(again.status).toBe(409);
    expect(again.error.message).toBe('Only a failed change can be retried; this one is done.');

    // Relist: a new eBay listing id, active again.
    const relisting = await api.call('relistListing', { token, params: { listingId: draft.id } });
    expect(relisting.status).toBe(202);
    const relisted = await settled(draft.id);
    expect(relisted.statusDisplay.label).toBe('Active (confirmed by eBay)');
    expect(relisted.externalListingId).not.toBe(active.externalListingId);

    // Every operation of the item, newest first.
    const operations = await api.call('listOperations', { token, query: { itemId: ready.id } });
    expect(operations.body.data.map((operation) => operation.kind)).toEqual([
      'relist',
      'end',
      'price',
      'create',
    ]);
    expect(operations.body.data[1]?.statusDisplay.label).toBe('Delisted (confirmed by eBay)');
  });

  it('reads a listing and its newest operation from one snapshot, never a stale row', async () => {
    const ready = await readyItem();
    const draft = await draftListing(ready.id);
    await api.call('publishListing', { token, params: { listingId: draft.id } });
    await settled(draft.id);
    // A row read before the worker recorded the result, as a caller may hold one.
    const stale = await findListing(api.db, tenant, draft.id);
    if (!stale) throw new Error('no listing');
    const [state] = await listingStates(api.db, tenant, [{ ...stale, status: 'draft' }]);
    expect(state?.row.status).toBe('active');
    expect(state?.operation?.status).toBe('succeeded');
  });

  it('refuses a publish eBay would refuse, before anything is queued', async () => {
    const ready = await readyItem();
    const draft = await draftListing(ready.id, { ...VARIANT, title: 'A'.repeat(81) });
    const response = await api.call('publishListing', { token, params: { listingId: draft.id } });
    expect(response.status).toBe(422);
    expect(response.error.message).toBe('eBay titles can be at most 80 characters.');
    expect(fieldsOf(response as { error: NonNullable<typeof response.error> })).toEqual([
      'variant.title',
    ]);
    const listing = await api.call('getListing', { token, params: { listingId: draft.id } });
    expect(listing.body.latestOperation).toBeUndefined();

    // The draft can still be fixed and published.
    const fixed = await api.call('replaceListingDraft', {
      token,
      params: { listingId: draft.id },
      body: { variant: VARIANT },
    });
    expect(fixed.status).toBe(200);
    expect(fixed.body.variant?.title).toBe(VARIANT.title);
  });

  it('lets the seller fix and publish again a draft whose publish was refused before sending', async () => {
    // A publish the engine refused before sending (an automated marketplace's own rules, such as
    // Poshmark's size): its content as the engine stored it, failed with nothing sent.
    const sent = await readyItem();
    const sentDraft = await draftListing(sent.id);
    await api.call('publishListing', { token, params: { listingId: sentDraft.id } });
    const published = await settled(sentDraft.id);
    const { content } = await api.db
      .selectFrom('marketplace_operation')
      .select('content')
      .where('id', '=', published.latestOperation?.id ?? '')
      .executeTakeFirstOrThrow();
    const ready = await readyItem();
    const draft = await draftListing(ready.id);
    await api.db
      .insertInto('marketplace_operation')
      .values({
        account_id: tenant.accountId,
        listing_id: draft.id,
        kind: 'create',
        idempotency_key: `refused-${draft.id}`,
        desired: jsonb({ status: 'active' }),
        status: 'failed',
        attempts: 1,
        error_code: 'validation_failed',
        error_message: 'eBay needs a standard size for clothing. Fix it, then try again.',
        origin: 'user',
        content: jsonb(content ?? {}),
      })
      .execute();

    // No Retry of content that can only fail again; publishing again is offered instead.
    const refused = await api.call('getListing', { token, params: { listingId: draft.id } });
    expect(refused.body.statusDisplay).toMatchObject({ tone: 'failed', label: 'Publish failed' });
    expect(refused.body.latestOperation?.error?.retryable).toBe(false);
    expect(refused.body.availableActions.map((available) => available.action)).toEqual(['publish']);

    // Nothing reached eBay, so the draft can still be edited, then published.
    const fixed = await api.call('replaceListingDraft', {
      token,
      params: { listingId: draft.id },
      body: { variant: { ...VARIANT, title: 'Fixed title' } },
    });
    expect(fixed.status).toBe(200);
    const again = await api.call('publishListing', { token, params: { listingId: draft.id } });
    expect(again.status).toBe(202);
    const live = await settled(draft.id);
    expect(live.statusDisplay.label).toBe('Active (confirmed by eBay)');
    expect(live.variant?.title).toBe('Fixed title');
  });

  it('allows one change at a time and only what the listing state allows', async () => {
    const ready = await readyItem();
    const draft = await draftListing(ready.id);
    const ending = await api.call('endListing', {
      token,
      params: { listingId: draft.id },
      body: { reason: 'other' },
    });
    expect(ending.status).toBe(409);
    expect(ending.error.code).toBe('invalid_state_transition');

    expect(
      (await api.call('publishListing', { token, params: { listingId: draft.id } })).status,
    ).toBe(202);
    const twice = await api.call('publishListing', { token, params: { listingId: draft.id } });
    expect(twice.status).toBe(409);
    const edit = await api.call('replaceListingDraft', {
      token,
      params: { listingId: draft.id },
      body: { variant: VARIANT },
    });
    expect(edit.status).toBe(409);
    const second = await api.call('createListing', {
      token,
      params: { itemId: ready.id },
      body: { marketplace: 'ebay', variant: VARIANT },
    });
    expect(second.status).toBe(409);
    expect(second.error.code).toBe('already_exists');
    await settled(draft.id);
  });

  it('replays a publish with the same Idempotency-Key instead of queueing it twice', async () => {
    const ready = await readyItem();
    const draft = await draftListing(ready.id);
    const key = crypto.randomUUID();
    const first = await api.call('publishListing', {
      token,
      params: { listingId: draft.id },
      idempotencyKey: key,
    });
    const replay = await api.call('publishListing', {
      token,
      params: { listingId: draft.id },
      idempotencyKey: key,
    });
    expect(replay.status).toBe(202);
    expect(replay.body.operation.id).toBe(first.body.operation.id);
    await settled(draft.id);
    const operations = await api.call('listOperations', { token, query: { listingId: draft.id } });
    expect(operations.body.data).toHaveLength(1);
  });

  it("hides another account's listings and operations", async () => {
    const ready = await readyItem();
    const draft = await draftListing(ready.id);
    await api.call('publishListing', { token, params: { listingId: draft.id } });
    const listing = await settled(draft.id);
    const strangerToken = await api.signIn(STRANGER);
    const operationId = listing.latestOperation?.id ?? '';
    for (const response of [
      await api.call('getListing', { token: strangerToken, params: { listingId: draft.id } }),
      await api.call('getOperation', { token: strangerToken, params: { operationId } }),
      await api.call('listOperationEvents', { token: strangerToken, params: { operationId } }),
      await api.call('retryOperation', { token: strangerToken, params: { operationId } }),
      await api.call('endListing', {
        token: strangerToken,
        params: { listingId: draft.id },
        body: { reason: 'other' },
      }),
    ]) {
      expect(response.status).toBe(404);
    }
    const page = await api.call('listOperations', { token: strangerToken });
    expect(page.body.data).toEqual([]);
  });

  it('filters inventory by marketplace and brand', async () => {
    const listed = await readyItem();
    await draftListing(listed.id);
    const other = await api.call('createItem', {
      token,
      body: { details: { title: 'Patagonia fleece', brand: 'Patagonia' } },
    });
    const onEbay = await api.call('listItems', { token, query: { marketplace: 'ebay' } });
    const ids = onEbay.body.data.map((summary) => summary.id);
    expect(ids).toContain(listed.id);
    expect(ids).not.toContain(other.body.id);
    expect(onEbay.body.data.find((summary) => summary.id === listed.id)?.listings).toEqual([
      expect.objectContaining({
        marketplace: 'ebay',
        statusDisplay: { tone: 'neutral', label: 'Draft' },
      }),
    ]);
    const patagonia = await api.call('listItems', { token, query: { brand: 'PATAGONIA' } });
    expect(patagonia.body.data.map((summary) => summary.id)).toEqual([other.body.id]);
  });
});

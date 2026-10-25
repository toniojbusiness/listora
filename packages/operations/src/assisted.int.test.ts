/**
 * The engine with the adapter framework (docs/features/marketplaces.md): assisted operations
 * finish only through the user's confirmation, never through a read-back; every operation runs
 * in the mode its capability flag gives it; nothing invalid is sent; and a connection switches a
 * listing from assisted to the API without any data migration.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  AssistedAdapter,
  ConnectionAwareAdapter,
  createDepopAssistedAdapter,
  FakeMarketplaceAdapter,
  type AssistedListingPayload,
  type AdapterLookup,
  type MarketplaceAdapter,
  type OperationRequest,
  type Outcome,
  type RemoteListingState,
} from '@listora/marketplaces';
import { contentWith, sampleListingContent } from '@listora/marketplaces/testing';

import { confirmOperationByUser, dismissOperationByUser, retryOperation } from './commands.ts';
import { describeListingStatus } from './status-display.ts';
import {
  createEngineHarness,
  FAKE_REQUEST_TIMEOUT_MS,
  type EngineHarness,
  type ListingRow,
} from './test-support.ts';
import type { OperationRow } from './transitions.ts';
import type { OperationWorker } from './worker.ts';

const SETTLED = ['succeeded', 'failed', 'canceled', 'needs_user_action'] as const;

/** A remote listing that matches every create the harness enqueues. */
function perfectMatch(op: OperationRow): RemoteListingState {
  const desired = op.desired as { title?: string; description?: string; priceCents?: number };
  return {
    found: true,
    externalListingId: 'POSH-1',
    externalUrl: null,
    status: 'active',
    title: desired.title ?? null,
    description: desired.description ?? null,
    priceCents: desired.priceCents ?? null,
    currency: 'USD',
    revision: null,
  };
}

/** Poshmark, but its reads would confirm anything, and it counts every call. */
class TemptingPoshmark extends AssistedAdapter {
  reads = 0;
  sends = 0;
  answer: ((op: OperationRequest<AssistedListingPayload>) => Outcome | undefined) | undefined;
  match: RemoteListingState = { found: false, authoritative: false };

  constructor() {
    super({ marketplace: 'poshmark', siteUrl: 'https://poshmark.com/' });
  }

  override execute(op: OperationRequest<AssistedListingPayload>): Promise<Outcome> {
    this.sends += 1;
    const answer = this.answer?.(op);
    return answer === undefined ? super.execute(op) : Promise.resolve(answer);
  }

  override readListing(): Promise<RemoteListingState> {
    this.reads += 1;
    return Promise.resolve(this.match);
  }
}

describe('assisted operations and connection-aware capabilities (real Postgres)', () => {
  let harness: EngineHarness;
  let worker: OperationWorker | undefined;

  beforeAll(async () => {
    harness = await createEngineHarness('assisted');
  });

  afterAll(async () => {
    await harness.close();
  });

  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
    expect(harness.fatalErrors).toEqual([]);
  });

  async function startWith(overrides: Partial<Record<string, MarketplaceAdapter>>) {
    const adapters: AdapterLookup = (marketplace) =>
      overrides[marketplace] ?? harness.adapters(marketplace);
    worker = await harness.startWorker({ adapters });
  }

  async function tasksOf(operationId: string) {
    return harness.db
      .selectFrom('user_task')
      .selectAll()
      .where('account_id', '=', harness.accountId)
      .where('operation_id', '=', operationId)
      .execute();
  }

  async function statusOf(listing: ListingRow, op: OperationRow) {
    const [current, row] = await Promise.all([
      harness.operation(op.id),
      harness.listing(listing.id),
    ]);
    return describeListingStatus({
      marketplace: row.marketplace,
      listingStatus: row.status,
      operation: {
        kind: current.kind,
        status: current.status,
        attempts: current.attempts,
        errorMessage: current.error_message,
        successEvidence: current.success_evidence,
      },
    }).label;
  }

  it('waits for the user even when a read would show the listing live', async () => {
    const poshmark = new TemptingPoshmark();
    await startWith({ poshmark });
    const listing = await harness.createListing('poshmark');
    const op = await harness.enqueue(listing, 'create', {
      status: 'active',
      title: 'Linen shirt',
      priceCents: 2800,
    });
    poshmark.match = perfectMatch(op);

    expect(await harness.waitForStatus(op.id, SETTLED)).toMatchObject({
      status: 'needs_user_action',
      success_evidence: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await harness.operation(op.id)).toMatchObject({ status: 'needs_user_action' });
    expect(poshmark.reads).toBe(0);
    expect(await statusOf(listing, op)).toBe('Action needed - list on Poshmark');

    const [task] = await tasksOf(op.id);
    expect(task).toMatchObject({
      kind: 'list_manually',
      status: 'open',
      deep_link: 'https://poshmark.com/',
      payload: {
        action: 'create',
        copyAssist: {
          title: 'Linen shirt',
          description: sampleListingContent().variant.description,
          price: { amountCents: 2800, currency: 'USD' },
          photos: [
            { photoId: 'photo-front', url: 'https://media.listora.test/p/front.jpg' },
            { photoId: 'photo-back', url: 'https://media.listora.test/p/back.jpg' },
            { photoId: 'photo-tag', url: 'https://media.listora.test/p/tag.jpg' },
          ],
        },
      },
    });

    const userId = await harness.addMember(`owner-${op.id}`);
    await confirmOperationByUser(harness.db, {
      accountId: harness.accountId,
      operationId: op.id,
      userId,
    });
    expect(await harness.operation(op.id)).toMatchObject({
      status: 'succeeded',
      success_evidence: 'user_confirmation',
    });
    expect(await statusOf(listing, op)).toBe('Done (you confirmed)');
    expect(poshmark.reads).toBe(0);

    // A check is not a way around the user either: assisted listings are never read.
    const verify = await harness.enqueue(listing, 'verify', { status: 'active' });
    expect(await harness.waitForStatus(verify.id, SETTLED)).toMatchObject({
      status: 'failed',
      error_code: 'cannot_verify',
    });
    expect(poshmark.reads).toBe(0);
  });

  it('fails a dismissed task, never succeeds it, and Retry gives the user a new task', async () => {
    const poshmark = new TemptingPoshmark();
    await startWith({ poshmark });
    const listing = await activePoshmarkListing();
    const op = await harness.enqueue(listing, 'end', { status: 'ended' });
    expect(await harness.waitForStatus(op.id, SETTLED)).toMatchObject({
      status: 'needs_user_action',
    });

    await dismissOperationByUser(harness.db, { accountId: harness.accountId, operationId: op.id });
    expect(await harness.operation(op.id)).toMatchObject({
      status: 'failed',
      success_evidence: null,
      error_code: 'dismissed_by_user',
    });
    expect(await tasksOf(op.id)).toEqual([expect.objectContaining({ status: 'dismissed' })]);
    expect(await statusOf(listing, op)).toBe('Delist failed - Retry');
    expect(await harness.listing(listing.id)).toMatchObject({ status: 'active' });
    // A dismissed step cannot be dismissed or confirmed again.
    await expect(
      dismissOperationByUser(harness.db, { accountId: harness.accountId, operationId: op.id }),
    ).rejects.toThrow(/failed/);

    await retryOperation(harness.db, { accountId: harness.accountId, operationId: op.id });
    expect(await harness.waitForStatus(op.id, SETTLED)).toMatchObject({
      status: 'needs_user_action',
    });
    const tasks = await tasksOf(op.id);
    expect(tasks.map((task) => task.status).sort()).toEqual(['dismissed', 'open']);
    expect(poshmark.reads).toBe(0);
  });

  async function activePoshmarkListing(): Promise<ListingRow> {
    const created = await harness.createListing('poshmark');
    return harness.db
      .updateTable('marketplace_listing')
      .set({ status: 'active' })
      .where('id', '=', created.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** The item sells on eBay, and the auto-delist ends the listing. */
  async function autoDelistAfterEbaySale(listing: ListingRow) {
    const sale = await harness.db
      .insertInto('sale')
      .values({
        account_id: harness.accountId,
        marketplace: 'ebay',
        sold_at: new Date(),
        detection_source: 'manual',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await harness.db
      .insertInto('sale_item')
      .values({
        account_id: harness.accountId,
        sale_id: sale.id,
        marketplace: 'ebay',
        item_id: listing.item_id,
        sale_price_cents: 3900,
      })
      .execute();
    const run = await harness.db
      .insertInto('delist_run')
      .values({ account_id: harness.accountId, sale_id: sale.id, item_id: listing.item_id })
      .returning('id')
      .executeTakeFirstOrThrow();
    const end = await harness.enqueue(
      listing,
      'end',
      { status: 'ended' },
      { origin: 'auto_delist', delistRunId: run.id },
    );
    return { end, delistRunId: run.id };
  }

  /** The delist asks the user at once (well within the harness's 60 s recheck of a blocked one). */
  async function expectUrgentDelistTask(
    listing: ListingRow,
    end: OperationRow,
    delistRunId: string,
  ) {
    expect(await harness.waitForStatus(end.id, SETTLED, 5_000)).toMatchObject({
      status: 'needs_user_action',
      success_evidence: null,
    });
    expect(await statusOf(listing, end)).toBe('Action needed - delist on Poshmark');
    expect(await tasksOf(end.id)).toEqual([
      expect.objectContaining({
        kind: 'delist_manually',
        status: 'open',
        urgency: 'urgent',
        delist_run_id: delistRunId,
      }),
    ]);
  }

  /** Closed as superseded by the delist, in its history, and never shown as done. */
  async function expectSuperseded(
    listing: ListingRow,
    op: OperationRow,
    end: OperationRow,
    from: OperationRow['status'],
  ) {
    expect(await harness.operation(op.id)).toMatchObject({
      status: 'canceled',
      success_evidence: null,
    });
    expect((await harness.events(op.id)).at(-1)).toMatchObject({
      from_status: from,
      to_status: 'canceled',
      detail: { action: 'supersede', reason: 'superseded by delist', supersededBy: end.id },
    });
    expect(await statusOf(listing, op)).not.toBe('Done (you confirmed)');
  }

  it('delists after a sale at once, past an edit the user never answered', async () => {
    await startWith({});
    const listing = await activePoshmarkListing();

    // A price change on Poshmark waits for the user, who ignores it.
    const edit = await harness.enqueue(listing, 'price', { priceCents: 3900 });
    expect(await harness.waitForStatus(edit.id, SETTLED)).toMatchObject({
      status: 'needs_user_action',
    });
    expect(await statusOf(listing, edit)).toBe('Action needed - change the price on Poshmark');

    const { end, delistRunId } = await autoDelistAfterEbaySale(listing);
    await expectUrgentDelistTask(listing, end, delistRunId);
    await expectSuperseded(listing, edit, end, 'needs_user_action');
    expect(await tasksOf(edit.id)).toEqual([
      expect.objectContaining({ kind: 'edit_manually', status: 'dismissed' }),
    ]);
  });

  it('delists after a sale at once, past an unanswered edit and a change queued behind it', async () => {
    await startWith({});
    const listing = await activePoshmarkListing();

    // A revise waits for the user, who ignores it; a price change then queues behind it.
    const revise = await harness.enqueue(listing, 'revise', {
      status: 'active',
      title: 'Linen shirt, ironed',
      priceCents: 2800,
    });
    expect(await harness.waitForStatus(revise.id, SETTLED)).toMatchObject({
      status: 'needs_user_action',
    });
    const price = await harness.enqueue(listing, 'price', { priceCents: 2500 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await harness.operation(price.id)).toMatchObject({ status: 'queued', attempts: 0 });

    const { end, delistRunId } = await autoDelistAfterEbaySale(listing);
    await expectUrgentDelistTask(listing, end, delistRunId);
    await expectSuperseded(listing, revise, end, 'needs_user_action');
    await expectSuperseded(listing, price, end, 'queued');
    expect(await tasksOf(revise.id)).toEqual([
      expect.objectContaining({ kind: 'edit_manually', status: 'dismissed' }),
    ]);
    expect(await tasksOf(price.id)).toEqual([]);
  });

  it.each([
    ['confirmed', { type: 'confirmed', externalListingId: 'POSH-9' }],
    ['unknown', { type: 'unknown', code: 'timeout', message: "Poshmark didn't answer in time." }],
  ] as const)(
    'never lets an assisted adapter that answers %s finish its operation',
    async (_answer, outcome) => {
      const poshmark = new TemptingPoshmark();
      poshmark.answer = () => outcome;
      await startWith({ poshmark });
      const listing = await harness.createListing('poshmark');
      const op = await harness.enqueue(listing, 'create', {
        status: 'active',
        title: 'Wool coat',
        priceCents: 9000,
      });
      poshmark.match = perfectMatch(op);

      expect(await harness.waitForStatus(op.id, SETTLED)).toMatchObject({
        status: 'failed',
        error_code: 'unconfirmed',
        success_evidence: null,
      });
      expect(poshmark.reads).toBe(0);
      expect(await tasksOf(op.id)).toEqual([]);
      expect(await statusOf(listing, op)).toBe('Publish failed - Retry');
    },
  );

  it('never hands an api operation to the user instead of reading it back', async () => {
    class AskingEbay extends FakeMarketplaceAdapter {
      override execute(): Promise<Outcome> {
        return Promise.resolve({
          type: 'pendingUser',
          task: { kind: 'list_manually', deepLink: null, payload: {} },
        });
      }
    }
    await startWith({ ebay: new AskingEbay({ marketplace: 'ebay', baseUrl: harness.fake.url }) });
    const listing = await harness.createListing('ebay');
    const op = await harness.enqueue(listing, 'create', {
      status: 'active',
      title: 'Silk scarf',
      priceCents: 1500,
    });
    expect(await harness.waitForStatus(op.id, SETTLED)).toMatchObject({
      status: 'failed',
      error_code: 'unconfirmed',
    });
    expect(await tasksOf(op.id)).toEqual([]);
  });

  it('fails a kind the marketplace cannot do, without asking its adapter', async () => {
    const poshmark = new TemptingPoshmark();
    await startWith({ poshmark });
    const listing = await harness.createListing('poshmark');
    const op = await harness.enqueue(listing, 'mark_sold', { status: 'sold' });
    expect(await harness.waitForStatus(op.id, SETTLED)).toMatchObject({
      status: 'failed',
      error_code: 'not_supported',
      error_message: "Listora can't mark listings sold on Poshmark.",
    });
    expect({ sends: poshmark.sends, reads: poshmark.reads }).toEqual({ sends: 0, reads: 0 });
  });

  it('sends nothing the adapter would refuse, and says what to fix', async () => {
    await startWith({});
    const listing = await harness.createListing('ebay');
    const op = await harness.enqueue(
      listing,
      'create',
      { status: 'active' },
      {
        content: contentWith({ title: 'Vintage denim jacket '.repeat(5).trim(), priceCents: 4000 }),
      },
    );
    expect(await harness.waitForStatus(op.id, SETTLED)).toMatchObject({
      status: 'failed',
      error_code: 'validation_failed',
      error_message: 'eBay titles can be at most 80 characters. Fix the listing, then try again.',
    });
    expect(harness.fake.requests.filter((request) => request.sku === listing.id)).toEqual([]);
    expect((await harness.events(op.id)).at(-1)?.detail).toMatchObject({
      sent: false,
      issues: [{ field: 'variant.title', code: 'too_long' }],
    });
  });

  it('builds each attempt from the content stored with the operation, not the item now', async () => {
    await startWith({});
    const listing = await harness.createListing('ebay');
    const content = contentWith({ title: 'Corduroy pants', priceCents: 3300 });
    const op = await harness.enqueue(listing, 'create', {}, { content });
    await harness.db
      .updateTable('inventory_item')
      .set({ title: 'Edited while queued' })
      .where('id', '=', listing.item_id)
      .execute();
    expect(await harness.waitForStatus(op.id, SETTLED)).toMatchObject({ status: 'succeeded' });
    expect(harness.fake.listings('ebay', listing.id)).toEqual([
      expect.objectContaining({
        title: 'Corduroy pants',
        priceCents: 3300,
        photoUrls: [
          'https://media.listora.test/p/front.jpg',
          'https://media.listora.test/p/back.jpg',
          'https://media.listora.test/p/tag.jpg',
        ],
      }),
    ]);
  });

  it('switches a listing from assisted to the api with its connection, without migrating it', async () => {
    const depop = new ConnectionAwareAdapter({
      assisted: createDepopAssistedAdapter(),
      api: new FakeMarketplaceAdapter({
        marketplace: 'depop',
        baseUrl: harness.fake.url,
        requestTimeoutMs: FAKE_REQUEST_TIMEOUT_MS,
      }),
    });
    await startWith({ depop });

    // A Depop listing the seller posted by hand and linked to Listora, before API access.
    const connection = await harness.db
      .insertInto('marketplace_connection')
      .values({ account_id: harness.accountId, marketplace: 'depop', mode: 'assisted' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const created = await harness.createListing('depop');
    const remote = harness.fake.seed('depop', {
      sku: created.id,
      status: 'active',
      title: 'Cropped cardigan',
      description: '',
      priceCents: 4500,
      currency: 'USD',
      photoUrls: ['https://media.listora.test/p/front.jpg'],
    });
    const listingUrl = 'https://www.depop.com/products/seller-cropped-cardigan/';
    const listing = await harness.db
      .updateTable('marketplace_listing')
      .set({
        connection_id: connection.id,
        status: 'active',
        external_listing_id: remote.id,
        external_url: listingUrl,
      })
      .where('id', '=', created.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    const assistedPrice = await harness.enqueue(listing, 'price', { priceCents: 3900 });
    expect(await harness.waitForStatus(assistedPrice.id, SETTLED)).toMatchObject({
      status: 'needs_user_action',
    });
    expect(await tasksOf(assistedPrice.id)).toEqual([
      expect.objectContaining({
        kind: 'edit_manually',
        deep_link: listingUrl,
        payload: { action: 'price', copyAssist: { price: { amountCents: 3900, currency: 'USD' } } },
      }),
    ]);
    expect(harness.fake.requests.filter((request) => request.sku === listing.id)).toEqual([]);
    const userId = await harness.addMember(`owner-${assistedPrice.id}`);
    await confirmOperationByUser(harness.db, {
      accountId: harness.accountId,
      operationId: assistedPrice.id,
      userId,
    });
    expect(await statusOf(listing, assistedPrice)).toBe('Done (you confirmed)');

    // Partner access is granted and the seller connects: only the connection's mode changes.
    await harness.db
      .updateTable('marketplace_connection')
      .set({ mode: 'api' })
      .where('id', '=', connection.id)
      .execute();

    const apiPrice = await harness.enqueue(listing, 'price', { priceCents: 4200 });
    expect(await harness.waitForStatus(apiPrice.id, SETTLED)).toMatchObject({
      status: 'succeeded',
      success_evidence: 'read_back',
    });
    expect(harness.fake.listings('depop', listing.id)).toEqual([
      expect.objectContaining({ id: remote.id, priceCents: 4200 }),
    ]);
    const after = await harness.listing(listing.id);
    expect(after).toMatchObject({
      id: listing.id,
      external_listing_id: remote.id,
      status: 'active',
    });
    expect(after.last_verified_at).toBeInstanceOf(Date);
    expect(await statusOf(listing, apiPrice)).toBe('Active (confirmed by Depop)');
  });
});

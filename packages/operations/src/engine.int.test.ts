import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { addJob } from '@listora/db';
import { FakeMarketplaceAdapter, type FakeAction } from '@listora/marketplaces';
import { contentWith, sampleListingContent } from '@listora/marketplaces/testing';

import {
  cancelOperation,
  confirmOperationByUser,
  enqueueOperation,
  retryOperation,
  type NewOperation,
} from './commands.ts';
import {
  IdempotencyConflictError,
  InvalidOperationError,
  InvalidTransitionError,
  NotAccountMemberError,
  SupersededOperationError,
} from './errors.ts';
import {
  FAST_POLICY,
  createEngineHarness,
  type EngineHarness,
  type ListingRow,
} from './test-support.ts';
import { OPERATION_TASK } from './jobs.ts';
import { MAINTENANCE_TASK } from './maintenance.ts';
import { maxAttempts } from './policy.ts';
import type { OperationWorker } from './worker.ts';

const SETTLED = ['succeeded', 'failed', 'canceled', 'needs_user_action'] as const;

describe('operation engine (real Postgres, fake marketplace)', () => {
  let harness: EngineHarness;
  let worker: OperationWorker | undefined;

  beforeAll(async () => {
    harness = await createEngineHarness('engine');
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    worker = await harness.startWorker();
  });

  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
    harness.fake.clearFaults();
    harness.fake.setLatency(0);
    harness.fake.setRelistIssuesNewId(false);
    expect(harness.fatalErrors).toEqual([]);
  });

  /** The fake's requests for one listing (the fake knows it by Listora's listing id). */
  function requests(listing: ListingRow, action?: FakeAction) {
    const externalId = listing.external_listing_id ?? '';
    return harness.fake.requests.filter(
      (request) =>
        (request.sku === listing.id || (externalId !== '' && request.listingId === externalId)) &&
        (action === undefined || request.action === action),
    );
  }

  async function transitions(operationId: string): Promise<string[]> {
    return (await harness.events(operationId)).map(
      (event) => `${event.from_status ?? 'new'}>${event.to_status}`,
    );
  }

  /** A listing that is already live on the fake eBay, created through the engine. */
  async function liveListing(priceCents = 4500): Promise<ListingRow> {
    const listing = await harness.createListing();
    const op = await harness.enqueue(listing, 'create', {
      status: 'active',
      title: 'Vintage denim jacket',
      priceCents,
    });
    await harness.waitForStatus(op.id, ['succeeded']);
    return harness.listing(listing.id);
  }

  it('creates a listing and succeeds only after reading it back', async () => {
    const listing = await harness.createListing();
    const op = await harness.enqueue(listing, 'create', {
      status: 'active',
      title: 'Vintage denim jacket',
      description: 'Size M',
      priceCents: 4500,
    });

    const done = await harness.waitForStatus(op.id, SETTLED);
    expect(done).toMatchObject({
      status: 'succeeded',
      success_evidence: 'read_back',
      attempts: 1,
      error_code: null,
      next_attempt_at: null,
    });
    expect(await transitions(op.id)).toEqual(['new>queued', 'queued>running', 'running>succeeded']);
    const succeeded = (await harness.events(op.id)).at(-1);
    expect(succeeded?.detail).toMatchObject({
      evidence: 'read_back',
      remote: { status: 'active', title: 'Vintage denim jacket', priceCents: 4500 },
    });

    const [remote] = harness.fake.listings('ebay', listing.id);
    expect(harness.fake.listings('ebay', listing.id)).toHaveLength(1);
    const updated = await harness.listing(listing.id);
    expect(updated).toMatchObject({
      status: 'active',
      external_listing_id: remote?.id,
      external_url: remote?.url,
      remote_snapshot: { status: 'active', priceCents: 4500, externalListingId: remote?.id },
    });
    expect(updated.last_verified_at).toBeInstanceOf(Date);
    expect(updated.listed_at).toBeInstanceOf(Date);
    expect(requests(updated).map((request) => request.action)).toEqual(['create', 'read']);
  });

  it('retries 429 and 5xx responses on the backoff schedule, then succeeds', async () => {
    const listing = await harness.createListing();
    harness.fake.inject({ action: 'create', sku: listing.id, fault: { type: 'rate_limited' } });
    harness.fake.inject({ action: 'create', sku: listing.id, fault: { type: 'server_error' } });
    const op = await harness.enqueue(listing, 'create', {
      status: 'active',
      title: 'Wool scarf',
      priceCents: 1800,
    });

    const done = await harness.waitForStatus(op.id, SETTLED);
    expect(done).toMatchObject({ status: 'succeeded', success_evidence: 'read_back', attempts: 3 });
    expect(await transitions(op.id)).toEqual([
      'new>queued',
      'queued>running',
      'running>retrying',
      'retrying>running',
      'running>retrying',
      'retrying>running',
      'running>succeeded',
    ]);
    const events = await harness.events(op.id);
    expect(events.filter((event) => event.to_status === 'retrying')).toEqual([
      expect.objectContaining({ attempt: 1, error_code: 'rate_limited' }),
      expect.objectContaining({ attempt: 2, error_code: 'server_error' }),
    ]);
    expect(events[2]?.detail).toMatchObject({ delayMs: FAST_POLICY.delaysMs[0] });
    expect(events[4]?.detail).toMatchObject({ delayMs: FAST_POLICY.delaysMs[1] });
    // Every resend was preceded by a read-back that showed the listing was not created yet.
    expect(requests(listing).map((request) => request.action)).toEqual([
      'create',
      'read',
      'create',
      'read',
      'create',
      'read',
    ]);
    expect(harness.fake.listings('ebay', listing.id)).toHaveLength(1);
  });

  it('reads back instead of resending when a 5xx response hid an applied change', async () => {
    const listing = await harness.createListing();
    harness.fake.inject({
      action: 'create',
      sku: listing.id,
      fault: { type: 'server_error', status: 502, afterApply: true },
    });
    const op = await harness.enqueue(listing, 'create', {
      status: 'active',
      title: 'Leather boots',
      priceCents: 6000,
    });

    const done = await harness.waitForStatus(op.id, SETTLED);
    expect(done).toMatchObject({ status: 'succeeded', success_evidence: 'read_back', attempts: 2 });
    expect(requests(listing, 'create')).toHaveLength(1);
    expect(harness.fake.listings('ebay', listing.id)).toHaveLength(1);
    expect((await harness.events(op.id)).at(-1)?.detail).toMatchObject({
      precheck: { matches: true },
      sent: false,
    });
  });

  it('verifies a timeout after sending by reading back, never by resending', async () => {
    const listing = await harness.createListing();
    harness.fake.inject({
      action: 'create',
      sku: listing.id,
      fault: { type: 'timeout_after_send' },
    });
    const op = await harness.enqueue(listing, 'create', {
      status: 'active',
      title: 'Silk blouse',
      priceCents: 3200,
    });

    const done = await harness.waitForStatus(op.id, SETTLED);
    expect(done).toMatchObject({ status: 'succeeded', success_evidence: 'read_back', attempts: 2 });
    expect(await transitions(op.id)).toEqual([
      'new>queued',
      'queued>running',
      'running>verifying',
      'verifying>succeeded',
    ]);
    const verifying = (await harness.events(op.id))[2];
    expect(verifying).toMatchObject({ error_code: 'timeout' });
    expect(requests(listing, 'create')).toHaveLength(1);
    expect(harness.fake.listings('ebay', listing.id)).toHaveLength(1);
  });

  it('never succeeds while the read-back disagrees, and succeeds once it agrees', async () => {
    const listing = await liveListing(4500);
    harness.fake.inject({
      action: 'read',
      sku: listing.id,
      fault: { type: 'stale_read' },
      times: 2,
    });
    const op = await harness.enqueue(listing, 'price', { priceCents: 3900 });

    const done = await harness.waitForStatus(op.id, SETTLED);
    expect(done).toMatchObject({ status: 'succeeded', success_evidence: 'read_back' });
    // Each stale read (older than the revision the update returned) is followed by another read.
    expect(await transitions(op.id)).toEqual([
      'new>queued',
      'queued>running',
      'running>verifying',
      'verifying>verifying',
      'verifying>succeeded',
    ]);
    const events = await harness.events(op.id);
    expect(events.slice(2, 4)).toEqual([
      expect.objectContaining({ error_code: 'stale_read' }),
      expect.objectContaining({ error_code: 'stale_read' }),
    ]);
    expect(events.at(-1)?.detail).toMatchObject({ remote: { priceCents: 3900, revision: 2 } });
    // The change was sent once.
    expect(requests(listing, 'update')).toHaveLength(1);
    expect(await harness.listing(listing.id)).toMatchObject({ remote_revision: 2 });
  });

  // Regression: a stale read of the listing as it was after the first end used to confirm the
  // second end while the listing was live again on the marketplace.
  it.each([
    ['ebay', 'stale_read'],
    ['depop', 'confirming'],
  ] as const)(
    'never confirms an end from a stale read of an earlier end (%s)',
    async (marketplace, undecidedCode) => {
      const listing = await harness.createListing(marketplace);
      const lifecycle = [
        ['create', { status: 'active', title: 'Rain jacket', priceCents: 3000 }],
        ['end', { status: 'ended' }],
        ['relist', { status: 'active' }],
      ] as const;
      for (const [kind, desired] of lifecycle) {
        const op = await harness.enqueue(listing, kind, desired);
        expect(await harness.waitForStatus(op.id, SETTLED)).toMatchObject({ status: 'succeeded' });
      }
      // The next end is rate-limited, so its second attempt reads the listing back first, and
      // that read is stale: it shows the listing ended, as it was before the relist.
      harness.fake.inject({ action: 'end', sku: listing.id, fault: { type: 'rate_limited' } });
      harness.fake.inject({ action: 'read', sku: listing.id, fault: { type: 'stale_read' } });
      const end = await harness.enqueue(listing, 'end', { status: 'ended' });

      expect(await harness.waitForStatus(end.id, SETTLED)).toMatchObject({
        status: 'succeeded',
        success_evidence: 'read_back',
      });
      // The success is real: the listing is ended on the marketplace, by an end sent after the
      // stale read.
      expect(harness.fake.listings(marketplace, listing.id)).toEqual([
        expect.objectContaining({ status: 'ended' }),
      ]);
      const events = await harness.events(end.id);
      expect(events.map((event) => event.error_code)).toContain(undecidedCode);
      expect(events.at(-1)?.detail).not.toHaveProperty('sent');
      const ends = harness.fake.requests.filter(
        (request) => request.sku === listing.id && request.action === 'end',
      );
      expect(ends.map((request) => request.status)).toEqual([200, 429, 200]);
    },
  );

  it('reads back the new listing id a relist returned, and never relists twice', async () => {
    const listing = await liveListing(1000);
    const end = await harness.enqueue(listing, 'end', { status: 'ended' });
    await harness.waitForStatus(end.id, ['succeeded']);
    harness.fake.setRelistIssuesNewId(true);
    // The read-back right after the relist fails, so a later step has to find the new listing.
    harness.fake.inject({ action: 'read', sku: listing.id, fault: { type: 'server_error' } });
    const relist = await harness.enqueue(listing, 'relist', { status: 'active' });

    const done = await harness.waitForStatus(relist.id, SETTLED);
    expect(done).toMatchObject({ status: 'succeeded', success_evidence: 'read_back' });
    expect(await transitions(relist.id)).toEqual([
      'new>queued',
      'queued>running',
      'running>verifying',
      'verifying>succeeded',
    ]);
    const live = harness.fake
      .listings('ebay', listing.id)
      .filter((remote) => remote.status === 'active');
    expect(live).toHaveLength(1);
    expect(live[0]?.id).not.toBe(listing.external_listing_id);
    expect(requests(listing, 'relist')).toHaveLength(1);
    // Verified, so the pending id became the listing's id, with its own revisions.
    expect(await harness.listing(listing.id)).toMatchObject({
      status: 'active',
      external_listing_id: live[0]?.id,
      remote_revision: 1,
      pending_external_listing_id: null,
      pending_remote_revision: null,
    });
  });

  // Regression: an unverified id from a relist used to be invisible to later operations, so an
  // auto-delist ended only the old, already ended listing and reported success.
  it('delists every listing id a relist may have left live, verified or not', async () => {
    const listing = await liveListing(1000);
    const end = await harness.enqueue(listing, 'end', { status: 'ended' });
    await harness.waitForStatus(end.id, ['succeeded']);
    harness.fake.setRelistIssuesNewId(true);
    // Every read-back of the relisted listing fails, so the relist fails honestly, but it is live.
    harness.fake.inject({
      action: 'read',
      sku: listing.id,
      fault: { type: 'server_error' },
      times: Infinity,
    });
    const relist = await harness.enqueue(listing, 'relist', { status: 'active' });
    expect(await harness.waitForStatus(relist.id, SETTLED)).toMatchObject({
      status: 'failed',
      error_code: 'unconfirmed',
    });
    harness.fake.clearFaults();
    const [relisted] = harness.fake
      .listings('ebay', listing.id)
      .filter((remote) => remote.status === 'active');
    expect(relisted?.id).toBeDefined();
    expect(await harness.listing(listing.id)).toMatchObject({
      external_listing_id: listing.external_listing_id,
      pending_external_listing_id: relisted?.id,
    });

    // The item sells on Depop; the auto-delist reaches both eBay listing ids.
    const delistRunId = await recordSale(harness, listing);
    const delist = await harness.enqueue(
      listing,
      'end',
      { status: 'ended' },
      { origin: 'auto_delist', delistRunId },
    );
    expect(await harness.waitForStatus(delist.id, SETTLED)).toMatchObject({
      status: 'succeeded',
      success_evidence: 'read_back',
    });
    expect(
      harness.fake.listings('ebay', listing.id).map((remote) => [remote.id, remote.status]),
    ).toEqual([
      [listing.external_listing_id, 'ended'],
      [relisted?.id, 'ended'],
    ]);
    expect(
      harness.fake.requests.filter(
        (request) => request.action === 'end' && request.listingId === relisted?.id,
      ),
    ).toHaveLength(1);
    // The success was proven by a read-back of each id.
    expect((await harness.events(delist.id)).at(-1)?.detail).toMatchObject({
      remote: { externalListingId: relisted?.id, status: 'ended' },
      otherRemotes: [{ externalListingId: listing.external_listing_id, status: 'ended' }],
    });
    expect(await harness.listing(listing.id)).toMatchObject({
      status: 'ended',
      external_listing_id: relisted?.id,
      pending_external_listing_id: null,
    });
  });

  // Regression: when the old listing id no longer existed (eBay drops ended listings), the end
  // on it was rejected, so the delist failed on every Retry while nothing was live.
  it('delists when the old listing id is gone and the pending one reads back ended', async () => {
    const listing = await liveListing(1000);
    const oldId = listing.external_listing_id ?? '';
    const end = await harness.enqueue(listing, 'end', { status: 'ended' });
    await harness.waitForStatus(end.id, ['succeeded']);
    harness.fake.setRelistIssuesNewId(true);
    harness.fake.inject({
      action: 'read',
      sku: listing.id,
      fault: { type: 'server_error' },
      times: Infinity,
    });
    const relist = await harness.enqueue(listing, 'relist', { status: 'active' });
    await harness.waitForStatus(relist.id, ['failed']);
    harness.fake.clearFaults();
    const [relisted] = harness.fake
      .listings('ebay', listing.id)
      .filter((remote) => remote.id !== oldId);
    harness.fake.remove('ebay', oldId);
    // The first end on the new listing is rate-limited, so the second attempt reads both ids
    // back first, and must not send again to the one it already found gone.
    harness.fake.inject({ action: 'end', sku: listing.id, fault: { type: 'rate_limited' } });

    const delistRunId = await recordSale(harness, listing);
    const delist = await harness.enqueue(
      listing,
      'end',
      { status: 'ended' },
      { origin: 'auto_delist', delistRunId },
    );
    expect(await harness.waitForStatus(delist.id, SETTLED)).toMatchObject({
      status: 'succeeded',
      success_evidence: 'read_back',
      attempts: 2,
    });
    expect(harness.fake.listings('ebay', listing.id)).toEqual([
      expect.objectContaining({ id: relisted?.id, status: 'ended' }),
    ]);
    const ends = (id: string | undefined) =>
      harness.fake.requests
        .filter((request) => request.action === 'end' && request.listingId === id)
        .map((request) => request.status);
    expect(ends(oldId)).toEqual([200, 410]);
    expect(ends(relisted?.id)).toEqual([429, 200]);
    expect((await harness.events(delist.id)).at(-1)?.detail).toMatchObject({
      remote: { externalListingId: relisted?.id, status: 'ended' },
      otherRemotes: [{ found: false, authoritative: true }],
    });
    // The pending id was confirmed, and the absent one is retired.
    expect(await harness.listing(listing.id)).toMatchObject({
      status: 'ended',
      external_listing_id: relisted?.id,
      pending_external_listing_id: null,
    });
  });

  it('stops cleanly mid-operation and leaves the step to be verified, not guessed', async () => {
    // A request timeout longer than the shutdown grace, so shutdown is what ends the request.
    await worker?.stop();
    const patient = new FakeMarketplaceAdapter({
      marketplace: 'ebay',
      baseUrl: harness.fake.url,
      requestTimeoutMs: 60_000,
    });
    worker = await harness.startWorker({ adapters: () => patient, callTimeoutMs: 60_000 });
    const listing = await harness.createListing();
    harness.fake.inject({
      action: 'create',
      sku: listing.id,
      fault: { type: 'hang', afterApply: true },
    });
    const op = await harness.enqueue(listing, 'create', {
      status: 'active',
      title: 'Bomber jacket',
      priceCents: 7000,
    });
    await harness.fake.waitForRequest((request) => request.sku === listing.id);

    // Graceful shutdown aborts the in-flight request after its grace period.
    await worker.stop();
    worker = undefined;
    expect(await harness.operation(op.id)).toMatchObject({
      status: 'verifying',
      error_code: 'aborted',
      success_evidence: null,
    });

    worker = await harness.startWorker();
    expect(await harness.waitForStatus(op.id, SETTLED)).toMatchObject({
      status: 'succeeded',
      success_evidence: 'read_back',
    });
    expect(requests(listing, 'create')).toHaveLength(1);
  }, 30_000);

  it('fails a rejected change at once, with the marketplace reason', async () => {
    const listing = await harness.createListing();
    harness.fake.inject({
      action: 'create',
      sku: listing.id,
      fault: { type: 'reject', message: 'Brand is required in this category' },
    });
    const op = await harness.enqueue(listing, 'create', {
      status: 'active',
      title: 'Canvas tote',
      priceCents: 1500,
    });

    const done = await harness.waitForStatus(op.id, SETTLED);
    expect(done).toMatchObject({
      status: 'failed',
      attempts: 1,
      success_evidence: null,
      error_code: 'validation_failed',
    });
    expect(done.error_message).toContain('Brand is required in this category');
    expect(done.error_message).toContain('eBay');
    expect(harness.fake.listings('ebay', listing.id)).toEqual([]);
  });

  it('fails with the error after the last attempt, and the Retry action recovers', async () => {
    const listing = await harness.createListing();
    harness.fake.inject({
      action: 'create',
      sku: listing.id,
      fault: { type: 'rate_limited' },
      times: Infinity,
    });
    const op = await harness.enqueue(listing, 'create', {
      status: 'active',
      title: 'Linen shirt',
      priceCents: 2200,
    });

    const failed = await harness.waitForStatus(op.id, SETTLED);
    expect(failed).toMatchObject({
      status: 'failed',
      attempts: maxAttempts(FAST_POLICY),
      error_code: 'rate_limited',
      error_message: 'eBay is limiting requests right now.',
      success_evidence: null,
    });
    expect(requests(listing, 'create')).toHaveLength(maxAttempts(FAST_POLICY));

    harness.fake.clearFaults();
    const queued = await retryOperation(harness.db, {
      accountId: harness.accountId,
      operationId: op.id,
    });
    expect(queued).toMatchObject({ status: 'queued', attempts: 0, error_code: null });

    const done = await harness.waitForStatus(op.id, ['succeeded', 'failed']);
    expect(done).toMatchObject({ status: 'succeeded', success_evidence: 'read_back', attempts: 1 });
    expect((await transitions(op.id)).slice(-3)).toEqual([
      'failed>queued',
      'queued>running',
      'running>succeeded',
    ]);
    expect(harness.fake.listings('ebay', listing.id)).toHaveLength(1);
  });

  it('enqueues idempotently by key and refuses a reused key', async () => {
    const listing = await harness.createListing();
    const input = {
      accountId: harness.accountId,
      listingId: listing.id,
      kind: 'create' as const,
      idempotencyKey: `idem-${listing.id}`,
      content: contentWith({ title: 'Denim skirt', priceCents: 2500 }),
      origin: 'user' as const,
    };
    const first = await enqueueOperation(harness.db, input);
    // The same content in another key order is the same operation.
    const reordered = JSON.parse(JSON.stringify(input.content), (_key, value: unknown) =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value,
    ) as typeof input.content;
    const again = await enqueueOperation(harness.db, { ...input, content: reordered });
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, operation: { id: first.operation.id } });
    expect(first.operation.desired).toEqual({
      status: 'active',
      title: 'Denim skirt',
      description: input.content.variant.description,
      priceCents: 2500,
      currency: 'USD',
    });

    await expect(
      enqueueOperation(harness.db, { ...input, content: contentWith({ priceCents: 9900 }) }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    const otherPhotos = sampleListingContent({
      item: { photos: [] },
      variant: input.content.variant,
    });
    await expect(
      enqueueOperation(harness.db, { ...input, content: otherPhotos }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    await harness.waitForStatus(first.operation.id, ['succeeded']);
    expect(requests(listing, 'create')).toHaveLength(1);
    expect(
      (await harness.events(first.operation.id)).filter((event) => event.from_status === null),
    ).toHaveLength(1);
  });

  it('rejects a desired state that a read-back could not verify', async () => {
    const listing = await harness.createListing();
    const base = { accountId: harness.accountId, listingId: listing.id, origin: 'user' as const };
    await expect(
      enqueueOperation(harness.db, {
        ...base,
        kind: 'price',
        idempotencyKey: 'empty',
        desired: {},
      }),
    ).rejects.toBeInstanceOf(InvalidOperationError);
    await expect(
      enqueueOperation(harness.db, {
        ...base,
        kind: 'end',
        idempotencyKey: 'wrong-status',
        desired: { status: 'active' },
      }),
    ).rejects.toBeInstanceOf(InvalidOperationError);
    await expect(
      enqueueOperation(harness.db, {
        ...base,
        kind: 'price',
        idempotencyKey: 'negative',
        desired: { priceCents: -1 },
      }),
    ).rejects.toBeInstanceOf(InvalidOperationError);
    await expect(
      enqueueOperation(harness.db, {
        ...base,
        kind: 'end',
        origin: 'auto_delist',
        idempotencyKey: 'no-run',
        desired: { status: 'ended' },
      }),
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });

  it('refuses listing content that is missing, misplaced, or malformed', async () => {
    const listing = await harness.createListing();
    const base = { accountId: harness.accountId, listingId: listing.id, origin: 'user' as const };
    const invalid = [
      // A create without content, as an untyped caller could send it.
      { ...base, kind: 'create', idempotencyKey: 'no-content', desired: { status: 'active' } },
      // An end carries no content.
      {
        ...base,
        kind: 'end',
        idempotencyKey: 'end-content',
        desired: { status: 'ended' },
        content: contentWith({}),
      },
      {
        ...base,
        kind: 'revise',
        idempotencyKey: 'bad-content',
        content: { ...contentWith({}), variant: { title: 'Jacket' } },
      },
    ] as unknown as NewOperation[];
    for (const input of invalid) {
      await expect(
        enqueueOperation(harness.db, input),
        input.idempotencyKey,
      ).rejects.toBeInstanceOf(InvalidOperationError);
    }
    const count = await harness.db
      .selectFrom('marketplace_operation')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('listing_id', '=', listing.id)
      .executeTakeFirstOrThrow();
    expect(count.count).toBe(0);
  });

  it('runs one listing at a time, in creation order, even when an older one retries', async () => {
    const listing = await liveListing(1000);
    harness.fake.setLatency(30);
    harness.fake.inject({ action: 'update', sku: listing.id, fault: { type: 'rate_limited' } });
    const first = await harness.enqueue(listing, 'price', { priceCents: 1500 });
    const second = await harness.enqueue(listing, 'price', { priceCents: 2000 });
    // A revise replaces the whole variant, price included.
    const third = await harness.enqueue(listing, 'revise', {
      title: 'Denim jacket, size M',
      priceCents: 2200,
    });

    for (const op of [first, second, third]) {
      expect(await harness.waitForStatus(op.id, SETTLED)).toMatchObject({ status: 'succeeded' });
    }
    expect(harness.fake.listings('ebay', listing.id)).toEqual([
      expect.objectContaining({ priceCents: 2200, title: 'Denim jacket, size M' }),
    ]);
    expect(harness.fake.maxInFlightPerSku).toBe(1);

    const finished = await Promise.all(
      [first, second, third].map(async (op) => (await harness.events(op.id)).at(-1)?.created_at),
    );
    const started = await Promise.all(
      [first, second, third].map(
        async (op) =>
          (await harness.events(op.id)).find((event) => event.to_status === 'running')?.created_at,
      ),
    );
    // Each operation started only after the one before it finished.
    expect(Number(started[1])).toBeGreaterThanOrEqual(Number(finished[0]));
    expect(Number(started[2])).toBeGreaterThanOrEqual(Number(finished[1]));
  });

  it('cancels a waiting operation without sending it', async () => {
    // With no worker running, the operation stays queued until it is canceled.
    await worker?.stop();
    worker = undefined;

    const fresh = await harness.createListing();
    const op = await harness.enqueue(fresh, 'create', {
      status: 'active',
      title: 'Cord trousers',
      priceCents: 2800,
    });
    const canceled = await cancelOperation(harness.db, {
      accountId: harness.accountId,
      operationId: op.id,
      reason: 'item sold elsewhere',
    });
    expect(canceled).toMatchObject({ status: 'canceled', next_attempt_at: null });

    worker = await harness.startWorker();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await harness.operation(op.id)).toMatchObject({ status: 'canceled' });
    expect(requests(fresh)).toEqual([]);
    expect((await harness.events(op.id)).at(-1)).toMatchObject({
      from_status: 'queued',
      to_status: 'canceled',
      detail: { action: 'cancel', reason: 'item sold elsewhere' },
    });
    await expect(
      retryOperation(harness.db, { accountId: harness.accountId, operationId: op.id }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('succeeds an assisted operation only through the user’s confirmation', async () => {
    const listing = await harness.createListing('poshmark');
    const op = await harness.enqueue(listing, 'create', {
      status: 'active',
      title: 'Floral dress',
      priceCents: 3500,
    });

    const waiting = await harness.waitForStatus(op.id, SETTLED);
    expect(waiting).toMatchObject({ status: 'needs_user_action', success_evidence: null });
    const tasks = await harness.db
      .selectFrom('user_task')
      .selectAll()
      .where('operation_id', '=', op.id)
      .execute();
    expect(tasks).toEqual([
      expect.objectContaining({
        kind: 'list_manually',
        status: 'open',
        listing_id: listing.id,
        item_id: listing.item_id,
        urgency: 'normal',
      }),
    ]);
    expect(tasks[0]).toMatchObject({
      deep_link: 'https://poshmark.com/',
      payload: {
        action: 'create',
        copyAssist: {
          title: 'Floral dress',
          price: { amountCents: 3500, currency: 'USD' },
          photos: [{ photoId: 'photo-front' }, { photoId: 'photo-back' }, { photoId: 'photo-tag' }],
        },
      },
    });
    expect(harness.fake.requests.filter((request) => request.marketplace === 'poshmark')).toEqual(
      [],
    );

    // Still waiting a while later: nothing but the user can finish it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await harness.operation(op.id)).toMatchObject({ status: 'needs_user_action' });

    const { id: stranger } = await harness.db
      .insertInto('app_user')
      .values({ auth_provider: 'dev', auth_subject: `stranger-${op.id}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    await expect(
      confirmOperationByUser(harness.db, {
        accountId: harness.accountId,
        operationId: op.id,
        userId: stranger,
      }),
    ).rejects.toBeInstanceOf(NotAccountMemberError);

    const userId = await harness.addMember(`owner-${op.id}`);
    const confirmed = await confirmOperationByUser(harness.db, {
      accountId: harness.accountId,
      operationId: op.id,
      userId,
    });
    expect(confirmed).toMatchObject({ status: 'succeeded', success_evidence: 'user_confirmation' });
    expect((await harness.events(op.id)).at(-1)).toMatchObject({
      from_status: 'needs_user_action',
      to_status: 'succeeded',
      detail: { evidence: 'user_confirmation', userId },
    });
    const [task] = await harness.db
      .selectFrom('user_task')
      .selectAll()
      .where('operation_id', '=', op.id)
      .execute();
    expect(task).toMatchObject({ status: 'done' });
    const updated = await harness.listing(listing.id);
    expect(updated).toMatchObject({
      status: 'active',
      last_verified_at: null,
      remote_snapshot: null,
    });
    // The user's confirmation is recorded as theirs, apart from any read-back.
    expect(updated.user_confirmed_at).toBeInstanceOf(Date);
  });

  it('lets a newer operation run only after the older one on its listing finishes', async () => {
    const listing = await harness.createListing('poshmark');
    const create = await harness.enqueue(listing, 'create', {
      status: 'active',
      title: 'Knit cardigan',
      priceCents: 2600,
    });
    await harness.waitForStatus(create.id, ['needs_user_action']);
    // Only a delist goes past an older user step (assisted.int.test.ts); a price change waits.
    const price = await harness.enqueue(listing, 'price', { priceCents: 2400 });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await harness.operation(price.id)).toMatchObject({ status: 'queued', attempts: 0 });

    const userId = await harness.addMember(`owner-${create.id}`);
    await confirmOperationByUser(harness.db, {
      accountId: harness.accountId,
      operationId: create.id,
      userId,
    });
    // Woken by the older operation finishing, not by the 60 s recheck.
    expect(await harness.waitForStatus(price.id, SETTLED, 3_000)).toMatchObject({
      status: 'needs_user_action',
    });
  });

  it('fails visibly, with a Retry action, when a marketplace has no adapter', async () => {
    const listing = await harness.createListing('mercari');
    const op = await harness.enqueue(listing, 'create', {
      status: 'active',
      title: 'Puffer vest',
      priceCents: 3000,
    });

    const failed = await harness.waitForStatus(op.id, SETTLED);
    expect(failed).toMatchObject({
      status: 'failed',
      error_code: 'marketplace_unavailable',
      error_message: "Listora can't connect to Mercari yet.",
    });
    await expect(
      retryOperation(harness.db, { accountId: harness.accountId, operationId: op.id }),
    ).resolves.toMatchObject({ status: 'queued' });
  });

  it('refuses to retry an operation that a newer one replaced', async () => {
    const listing = await liveListing(1000);
    harness.fake.inject({ action: 'update', sku: listing.id, fault: { type: 'reject' } });
    const older = await harness.enqueue(listing, 'price', { priceCents: 1200 });
    await harness.waitForStatus(older.id, ['failed']);
    const newer = await harness.enqueue(listing, 'price', { priceCents: 1300 });
    await harness.waitForStatus(newer.id, ['succeeded']);

    await expect(
      retryOperation(harness.db, { accountId: harness.accountId, operationId: older.id }),
    ).rejects.toBeInstanceOf(SupersededOperationError);
  });

  it('ends and verifies a listing, treating "already ended" as something to read back', async () => {
    const listing = await liveListing(1000);
    const end = await harness.enqueue(listing, 'end', { status: 'ended' });
    expect(await harness.waitForStatus(end.id, SETTLED)).toMatchObject({ status: 'succeeded' });
    const ended = await harness.listing(listing.id);
    expect(ended).toMatchObject({ status: 'ended' });
    expect(ended.ended_at).toBeInstanceOf(Date);

    // Ending again: the fake answers 409 already_ended; the read-back still decides.
    const again = await harness.enqueue(listing, 'end', { status: 'ended' });
    expect(await harness.waitForStatus(again.id, SETTLED)).toMatchObject({
      status: 'succeeded',
      success_evidence: 'read_back',
    });
  });

  it('runs an auto-delist at once while photo and analysis jobs fill their own pool', async () => {
    await worker?.stop();
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: unknown[] = [];
    worker = await harness.startWorker({
      concurrency: 1,
      taskConcurrency: 1,
      tasks: {
        slow_analysis: async (payload) => {
          started.push(payload);
          await blocked;
        },
      },
    });
    try {
      const listing = await liveListing(1000);
      for (const n of ['1', '2', '3']) {
        await addJob(harness.db, { task: 'slow_analysis', payload: { n }, jobKey: `slow:${n}` });
      }
      for (let tries = 0; started.length === 0; tries += 1) {
        if (tries > 200) throw new Error('the slow job never started');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const delistRunId = await recordSale(harness, listing);
      const delist = await harness.enqueue(
        listing,
        'end',
        { status: 'ended' },
        { origin: 'auto_delist', delistRunId },
      );
      expect(await harness.waitForStatus(delist.id, SETTLED, 5_000)).toMatchObject({
        status: 'succeeded',
      });
      // The background pool is still full: the delist did not wait for it.
      expect(started).toEqual([{ n: '1' }]);
      expect(worker.taskPoolId).toBeDefined();
      expect(worker.taskPoolId).not.toBe(worker.poolId);
    } finally {
      release();
    }
  });

  it('also runs the other jobs it is given, and refuses one named like an engine task', async () => {
    const payloads: unknown[] = [];
    const extra = await harness.startWorker({
      tasks: {
        extra_job: async (payload) => {
          payloads.push(payload);
        },
      },
    });
    await sql`select graphile_worker.add_job('extra_job', json_build_object('n', 1))`.execute(
      harness.db,
    );
    const deadline = Date.now() + 10_000;
    while (payloads.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await extra.stop();
    expect(payloads).toEqual([{ n: 1 }]);

    await expect(
      harness.startWorker({ tasks: { marketplace_operation: () => Promise.resolve() } }),
    ).rejects.toThrow("task marketplace_operation is the worker's own");
  });

  it('keeps every history event redacted and in step with the operation row', async () => {
    const listing = await harness.createListing();
    harness.fake.inject({ action: 'create', sku: listing.id, fault: { type: 'server_error' } });
    const op = await harness.enqueue(listing, 'create', {
      status: 'active',
      title: 'Track jacket',
      priceCents: 4000,
    });
    const done = await harness.waitForStatus(op.id, SETTLED);
    const events = await harness.events(op.id);
    for (const [index, event] of events.entries()) {
      expect(event.from_status).toBe(index === 0 ? null : events[index - 1]?.to_status);
    }
    expect(events.at(-1)).toMatchObject({ to_status: done.status, attempt: done.attempts });
    await expect(
      sql`update operation_event set detail = '{}' where operation_id = ${op.id}`.execute(
        harness.db,
      ),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it("registers the host's scheduled tasks on the cron and runs them", async () => {
    await worker?.stop();
    let ran: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      ran = resolve;
    });
    worker = await harness.startWorker({
      scheduledTasks: [
        {
          name: 'host_check',
          schedule: '7 * * * *',
          run: async () => {
            ran();
          },
        },
      ],
    });

    await vi.waitFor(
      async () => {
        const crontabs = await sql<{ identifier: string }>`
          select identifier from graphile_worker._private_known_crontabs
        `.execute(harness.db);
        expect(crontabs.rows.map((row) => row.identifier)).toEqual(
          expect.arrayContaining(['host_check', MAINTENANCE_TASK]),
        );
      },
      { timeout: 10_000, interval: 50 },
    );
    // Scheduled tasks run on the background runner, apart from the operation steps.
    expect(worker.taskPoolId).toBeDefined();
    await sql`select graphile_worker.add_job('host_check')`.execute(harness.db);
    await done;
  });

  it.each([
    [{ name: OPERATION_TASK, schedule: '7 * * * *' }, 'already taken'],
    [{ name: 'Host-Check', schedule: '7 * * * *' }, 'is not valid'],
    [{ name: 'host_check', schedule: '@hourly' }, 'five crontab time fields'],
    [{ name: 'host_check', schedule: '7 * * * *', maxAttempts: 0 }, 'positive maxAttempts'],
  ])('refuses the scheduled task %j', async (task, message) => {
    await expect(
      harness.startWorker({ scheduledTasks: [{ ...task, run: async () => undefined }] }),
    ).rejects.toThrow(message);
  });
});

/** Records a manual Depop sale of the listing's item and returns its delist run. */
async function recordSale(harness: EngineHarness, listing: ListingRow): Promise<string> {
  const sale = await harness.db
    .insertInto('sale')
    .values({
      account_id: harness.accountId,
      marketplace: 'depop',
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
      marketplace: 'depop',
      item_id: listing.item_id,
      sale_price_cents: 1000,
    })
    .execute();
  const run = await harness.db
    .insertInto('delist_run')
    .values({ account_id: harness.accountId, sale_id: sale.id, item_id: listing.item_id })
    .returning('id')
    .executeTakeFirstOrThrow();
  return run.id;
}

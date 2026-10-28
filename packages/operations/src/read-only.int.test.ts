import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { OPERATION_KINDS, type OperationKind } from '@listora/db';

import { retryOperation } from './commands.ts';
import {
  isWriteKind,
  READ_ONLY_ERROR,
  ReadOnlyConnectionError,
  setConnectionReadOnly,
} from './read-only.ts';
import { createEngineHarness, type EngineHarness, type ListingRow } from './test-support.ts';
import type { OperationWorker } from './worker.ts';

const SETTLED = ['succeeded', 'failed', 'canceled', 'needs_user_action'] as const;

/** What each kind's operation wants the listing to show. */
const DESIRED = {
  create: { status: 'active', title: 'Linen shirt', priceCents: 2500, currency: 'USD' },
  revise: { status: 'active', title: 'Linen shirt', priceCents: 2500, currency: 'USD' },
  price: { priceCents: 2200, currency: 'USD' },
  end: { status: 'ended' },
  relist: { status: 'active', title: 'Linen shirt', priceCents: 2500, currency: 'USD' },
  mark_sold: { status: 'sold' },
  verify: { status: 'active' },
  refresh: { refreshedAfter: '2026-10-28T00:00:00.000Z' },
} as const satisfies Record<OperationKind, object>;

describe('read-only connections in the operation engine (real Postgres, fake marketplace)', () => {
  let harness: EngineHarness;
  let worker: OperationWorker | undefined;
  let connectionId: string;

  beforeAll(async () => {
    harness = await createEngineHarness('read_only');
    const connection = await harness.db
      .insertInto('marketplace_connection')
      .values({ account_id: harness.accountId, marketplace: 'ebay', mode: 'api' })
      .returning('id')
      .executeTakeFirstOrThrow();
    connectionId = connection.id;
  });

  afterAll(async () => {
    await harness.close();
  });

  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
    await setReadOnly(false);
    expect(harness.fatalErrors).toEqual([]);
  });

  async function setReadOnly(readOnly: boolean): Promise<void> {
    await harness.db
      .updateTable('marketplace_connection')
      .set({ read_only: readOnly })
      .where('id', '=', connectionId)
      .execute();
  }

  async function connectedListing(): Promise<ListingRow> {
    const listing = await harness.createListing('ebay');
    return harness.db
      .updateTable('marketplace_listing')
      .set({ connection_id: connectionId })
      .where('id', '=', listing.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** A listing live on the fake eBay, published through the engine while it could change. */
  async function liveListing(): Promise<ListingRow> {
    const listing = await connectedListing();
    worker = await harness.startWorker();
    const created = await harness.enqueue(listing, 'create', DESIRED.create);
    expect((await harness.waitForStatus(created.id, SETTLED)).status).toBe('succeeded');
    await worker.stop();
    worker = undefined;
    return harness.listing(listing.id);
  }

  async function operationsOf(listingId: string): Promise<number> {
    const rows = await harness.db
      .selectFrom('marketplace_operation')
      .select('id')
      .where('listing_id', '=', listingId)
      .execute();
    return rows.length;
  }

  it('refuses every change to a listing on a read-only connection, and queues nothing', async () => {
    await setReadOnly(true);
    for (const kind of OPERATION_KINDS.filter(isWriteKind)) {
      const listing = await connectedListing();
      await expect(harness.enqueue(listing, kind, DESIRED[kind]), kind).rejects.toBeInstanceOf(
        ReadOnlyConnectionError,
      );
      expect(await operationsOf(listing.id), kind).toBe(0);
    }
    // The message tells the seller what is going on and how to change it.
    const listing = await connectedListing();
    await expect(harness.enqueue(listing, 'end', DESIRED.end)).rejects.toThrow(
      "Your eBay account is read only, so Listora won't change anything on it.",
    );
  });

  it('still lets Listora check a listing on a read-only connection', async () => {
    const listing = await liveListing();
    await setReadOnly(true);
    worker = await harness.startWorker();
    const check = await harness.enqueue(listing, 'verify', DESIRED.verify);
    expect((await harness.waitForStatus(check.id, SETTLED)).status).toBe('succeeded');
  });

  it("treats a listing without a connection as read only when the account's connection on its marketplace is", async () => {
    await setReadOnly(true);
    const listing = await harness.createListing('ebay');
    expect(listing.connection_id).toBeNull();
    await expect(harness.enqueue(listing, 'end', DESIRED.end)).rejects.toBeInstanceOf(
      ReadOnlyConnectionError,
    );
    // Another marketplace's listing is not affected.
    const depop = await harness.createListing('depop');
    await expect(harness.enqueue(depop, 'end', DESIRED.end)).resolves.toMatchObject({
      status: 'queued',
    });
  });

  it('fails a change queued before the connection became read only, without sending it', async () => {
    const listing = await liveListing();
    const ended = await harness.enqueue(listing, 'end', DESIRED.end);
    // Read only from now on, with nothing else touched (as the one-off migration sets it).
    await setReadOnly(true);
    const before = harness.fake.requests.length;
    worker = await harness.startWorker();
    const failed = await harness.waitForStatus(ended.id, SETTLED);
    expect(failed).toMatchObject({ status: 'failed', error_code: READ_ONLY_ERROR });
    expect(
      harness.fake.requests.slice(before).filter((request) => request.action === 'end'),
    ).toEqual([]);
    expect((await harness.listing(listing.id)).status).toBe('active');
  });

  it('fails the waiting changes once the seller makes the connection read only, and refuses Retry until they turn it off', async () => {
    const listing = await liveListing();
    const price = await harness.enqueue(listing, 'price', DESIRED.price);
    const changed = await setConnectionReadOnly(
      harness.db,
      { accountId: harness.accountId, connectionId },
      true,
    );
    expect(changed).toEqual({ marketplace: 'ebay', refused: [price.id] });
    expect(await harness.operation(price.id)).toMatchObject({
      status: 'failed',
      error_code: READ_ONLY_ERROR,
    });
    const target = { accountId: harness.accountId, operationId: price.id };
    await expect(retryOperation(harness.db, target)).rejects.toBeInstanceOf(
      ReadOnlyConnectionError,
    );

    // Turned off again, the change can be retried and goes through.
    await setConnectionReadOnly(harness.db, { accountId: harness.accountId, connectionId }, false);
    worker = await harness.startWorker();
    await retryOperation(harness.db, target);
    expect((await harness.waitForStatus(price.id, SETTLED)).status).toBe('succeeded');
  });

  it('says so for a connection the account does not have', async () => {
    await expect(
      setConnectionReadOnly(
        harness.db,
        { accountId: harness.accountId, connectionId: '0199a1f0-0000-7000-8000-00000000dead' },
        true,
      ),
    ).resolves.toBeUndefined();
  });
});

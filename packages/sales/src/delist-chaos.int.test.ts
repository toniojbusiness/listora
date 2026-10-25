/**
 * The auto-delist chaos test (plan task T-20): an item listed on eBay and Depop through their
 * real adapters (against the fake eBay and the fake Depop) and on Poshmark and Mercari
 * (assisted) sells, and the delist run must show exactly what happened on each marketplace.
 * Depop's delist times out after it was applied, so it is checked by read-back and never sent
 * twice; assisted listings wait for the seller and are done only when the seller confirms.
 * While the worker runs, every snapshot of the run is checked against the marketplaces
 * themselves: a listing is never shown delisted before the marketplace shows it ended, an
 * assisted one never before the seller confirmed, and the run never completes early.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AccessTokenResult } from '@listora/connections';
import {
  ALERT_STATES,
  loadDelistRuns,
  runDelistSla,
  type DelistRunView,
} from '@listora/auto-delist';
import { createInventoryItem, type Db, type Marketplace } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import {
  createDepopAdapter,
  createEbayAdapter,
  createMercariAdapter,
  createPoshmarkAdapter,
  EbayOAuthClient,
  FakeDepop,
  FakeEbay,
  loadDepopConfig,
  loadEbayConfig,
  type AdapterLookup,
  type ListingContent,
  type MarketplaceAdapter,
} from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';
import {
  confirmOperationByUser,
  enqueueOperation,
  isListingResyncPayload,
  LISTING_RESYNC_TASK,
  runListingResync,
  startOperationWorker,
  type OperationWorker,
  type RetryPolicy,
} from '@listora/operations';
import { deliverPush, PUSH_TASK, RecordingPushSender } from '@listora/push';
import { createLogger } from '@listora/shared';
import { sql } from 'kysely';

import { processEbayNotification, type SellerTokens } from './ebay/process.ts';
import { recordInboundEvent } from './inbound.ts';
import { recordSale } from './sales.ts';

const logger = createLogger({ service: 'delist-chaos-test', level: 'silent' });
const FAKE_EBAY_SELLER = 'fakeUser1';
const POLICY: RetryPolicy = { delaysMs: [60, 70, 80, 90, 100, 110], jitter: 0, random: () => 0.5 };
const signal = () => AbortSignal.timeout(10_000);

describe('auto-delist chaos: an item listed on four marketplaces sells', () => {
  let database: MigratedDatabase;
  let db: Db;
  let accountId: string;
  let userId: string;
  let ebayFake: FakeEbay;
  let depopFake: FakeDepop;
  let ebayConnection: string;
  let depopConnection: string;
  let adapters: AdapterLookup;
  let tokens: SellerTokens;
  let worker: OperationWorker;
  const sender = new RecordingPushSender();
  const fatalErrors: Error[] = [];

  beforeAll(async () => {
    database = await createMigratedDatabase('sales_delist_chaos', { jobQueue: true, max: 10 });
    db = database.db;
    accountId = await insertAccount(db, 'CH');
    const user = await db
      .insertInto('app_user')
      .values({ auth_provider: 'dev', auth_subject: 'chaos-seller' })
      .returning('id')
      .executeTakeFirstOrThrow();
    userId = user.id;
    await db
      .insertInto('membership')
      .values({ account_id: accountId, user_id: userId, role: 'owner' })
      .execute();

    ebayFake = await FakeEbay.start();
    depopFake = await FakeDepop.start();
    const connection = async (marketplace: Marketplace, externalUserId: string) =>
      (
        await db
          .insertInto('marketplace_connection')
          .values({
            account_id: accountId,
            marketplace,
            mode: 'api',
            external_user_id: externalUserId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    ebayConnection = await connection('ebay', FAKE_EBAY_SELLER);
    depopConnection = await connection('depop', String(depopFake.developmentSellerId));

    const ebayConfig = loadEbayConfig({
      EBAY_ENV: 'fake',
      EBAY_FAKE_URL: ebayFake.url,
      EBAY_USER_CONNECTION_ID: ebayConnection,
    });
    const depopConfig = loadDepopConfig({
      DEPOP_ENV: 'fake',
      DEPOP_FAKE_URL: depopFake.url,
      DEPOP_USER_CONNECTION_ID: depopConnection,
    });
    if (ebayConfig === undefined || depopConfig === undefined) throw new Error('no config');
    const registered = new Map<Marketplace, MarketplaceAdapter>([
      ['ebay', createEbayAdapter(ebayConfig, { requestTimeoutMs: 2_000 })],
      ['depop', createDepopAdapter(depopConfig, { requestTimeoutMs: 400, refusalGraceMs: 30 })],
      ['poshmark', createPoshmarkAdapter()],
      ['mercari', createMercariAdapter()],
    ]);
    adapters = (marketplace) => registered.get(marketplace);
    const oauth = new EbayOAuthClient({
      tokenUrl: ebayConfig.endpoints.oauthToken,
      clientId: ebayConfig.clientId,
      clientSecret: ebayConfig.clientSecret,
    });
    tokens = {
      accessToken: async (): Promise<AccessTokenResult> => ({
        type: 'ok',
        accessToken: (
          await oauth.refreshUserToken(ebayConfig.seller?.refreshToken ?? '', [], signal())
        ).token,
      }),
      invalidate: () => Promise.resolve(),
    };
    // Warm up both adapters, so the short timeouts hold on a loaded machine.
    for (const [marketplace, id] of [
      ['ebay', ebayConnection],
      ['depop', depopConnection],
    ] as const) {
      await registered
        .get(marketplace)
        ?.healthCheck({ signal: signal(), connection: { id, mode: 'api' } });
    }

    worker = await startOperationWorker({
      connectionString: database.scratch.url,
      db,
      adapters,
      logger,
      policy: POLICY,
      concurrency: 4,
      callTimeoutMs: 2_000,
      pollIntervalMs: 20,
      recoveryIntervalMs: 200,
      recoveryGraceMs: 200,
      tasks: {
        [PUSH_TASK]: (payload, abort) => deliverPush({ sender, logger }, payload, abort),
        [LISTING_RESYNC_TASK]: async (payload, abort) => {
          if (isListingResyncPayload(payload)) {
            await runListingResync({ db, adapters, logger }, payload, abort);
          }
        },
      },
      onFatalError: (error) => fatalErrors.push(error),
    });
  });

  afterAll(async () => {
    await worker.stop();
    await ebayFake.close();
    expect(depopFake.specViolations).toEqual([]);
    await depopFake.close();
    await database.close();
    expect(fatalErrors).toEqual([]);
  });

  interface Listed {
    itemId: string;
    sku: string;
    listings: Record<Marketplace, string>;
    /** The marketplace's own ids of the API listings. */
    ebayItemId: string;
    depopSku: string;
  }

  /** Lists an item on eBay and Depop through the engine and links its assisted listings. */
  async function listEverywhere(title: string): Promise<Listed> {
    const item = await createInventoryItem(db, accountId, { title, status: 'listed' });
    const insert = async (marketplace: Marketplace, values: Record<string, unknown> = {}) =>
      (
        await db
          .insertInto('marketplace_listing')
          .values({ account_id: accountId, item_id: item.id, marketplace, ...values })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const publish = async (listingId: string, content: ListingContent) => {
      const { operation } = await enqueueOperation(db, {
        accountId,
        listingId,
        idempotencyKey: `create-${listingId}`,
        origin: 'user',
        kind: 'create',
        content,
      });
      await waitFor(async () => (await operationStatus(operation.id)) === 'succeeded');
    };
    const ebay = await insert('ebay', { connection_id: ebayConnection });
    const depop = await insert('depop', { connection_id: depopConnection });
    await publish(ebay, sampleListingContent({ item: { itemId: item.id, sku: item.sku } }));
    await publish(
      depop,
      sampleListingContent({
        item: { itemId: item.id, sku: item.sku, category: 'clothing/tops/t_shirts' },
      }),
    );
    // The seller posted these themselves and shared them to Listora (assisted).
    const linked = (url: string) => ({
      status: 'active',
      external_url: url,
      user_confirmed_at: new Date(),
    });
    const poshmark = await insert('poshmark', linked(`https://poshmark.com/listing/${item.sku}`));
    const mercari = await insert('mercari', linked(`https://www.mercari.com/us/item/${item.sku}`));
    const rows = await db
      .selectFrom('marketplace_listing')
      .select(['marketplace', 'external_listing_id'])
      .where('item_id', '=', item.id)
      .execute();
    const external = (marketplace: Marketplace) =>
      rows.find((row) => row.marketplace === marketplace)?.external_listing_id ?? '';
    return {
      itemId: item.id,
      sku: item.sku,
      listings: { ebay, depop, poshmark, mercari },
      ebayItemId: external('ebay'),
      depopSku: external('depop'),
    };
  }

  const operationStatus = async (operationId: string) =>
    (
      await db
        .selectFrom('marketplace_operation')
        .select('status')
        .where('id', '=', operationId)
        .executeTakeFirstOrThrow()
    ).status;
  const runOf = async (itemId: string): Promise<DelistRunView | undefined> =>
    (await loadDelistRuns(db, accountId, { itemIds: [itemId] })).at(-1);
  const byMarketplace = (run: DelistRunView | undefined) =>
    Object.fromEntries(
      (run?.results ?? []).map((result) => [
        result.marketplace,
        { state: result.state, label: result.display.label, mode: result.mode },
      ]),
    );

  /**
   * Checks every snapshot of the item's run, while the worker runs, against what the fakes
   * show and what the seller confirmed. Returns the states seen per marketplace.
   */
  function watch(listed: Listed, confirmed: Set<Marketplace>) {
    const seen = new Map<Marketplace, Set<string>>();
    const violations: string[] = [];
    const stopping = new AbortController();
    const done = (async () => {
      while (!stopping.signal.aborted) {
        const run = await runOf(listed.itemId);
        const evidence = new Map(
          (
            await db
              .selectFrom('marketplace_operation')
              .select(['id', 'status', 'success_evidence'])
              .where(
                'id',
                'in',
                (run?.results ?? [])
                  .map((result) => result.operationId)
                  .concat(['00000000-0000-0000-0000-000000000000']),
              )
              .execute()
          ).map((op) => [op.id, op]),
        );
        // Read the marketplaces after the run: a success recorded before this read must
        // already show there.
        const ebayStatus = ebayFake.listing(listed.ebayItemId)?.status;
        const depopStatus = depopFake.product(listed.depopSku)?.status;
        for (const result of run?.results ?? []) {
          const states = seen.get(result.marketplace) ?? new Set<string>();
          states.add(result.state);
          seen.set(result.marketplace, states);
          // Read after the run: an operation that succeeded by then was already a success.
          const op = evidence.get(result.operationId);
          if (result.state === 'delisted' && op?.success_evidence !== 'read_back') {
            violations.push(
              `${result.marketplace} delisted without a read-back (${op?.status ?? '?'})`,
            );
          }
          if (result.state === 'user_confirmed' && op?.success_evidence !== 'user_confirmation') {
            violations.push(`${result.marketplace} done without the seller's confirmation`);
          }
          if (result.state === 'delisted') {
            if (result.mode !== 'api')
              violations.push(`${result.marketplace} delisted while assisted`);
            if (result.marketplace === 'ebay' && ebayStatus === 'Active') {
              violations.push('eBay shown delisted while its listing is active');
            }
            if (result.marketplace === 'depop' && depopStatus === 'STATUS_ONSALE') {
              violations.push('Depop shown delisted while its product is on sale');
            }
          }
          if (result.state === 'user_confirmed' && !confirmed.has(result.marketplace)) {
            violations.push(`${result.marketplace} shown done before the seller confirmed`);
          }
          if (
            result.display.tone === 'success' &&
            result.state !== 'delisted' &&
            result.state !== 'user_confirmed'
          ) {
            violations.push(`${result.marketplace} shows success while ${result.state}`);
          }
        }
        if (
          run?.status === 'completed' &&
          run.results.some((result) => !['delisted', 'user_confirmed'].includes(result.state))
        ) {
          violations.push('the run completed early');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    return {
      seen,
      violations,
      stop: async () => {
        stopping.abort();
        await done;
      },
    };
  }

  async function confirm(
    run: DelistRunView | undefined,
    marketplace: Marketplace,
    confirmed: Set<Marketplace>,
  ) {
    const result = run?.results.find((candidate) => candidate.marketplace === marketplace);
    if (result === undefined) throw new Error(`no ${marketplace} result`);
    confirmed.add(marketplace);
    await confirmOperationByUser(db, { accountId, operationId: result.operationId, userId });
  }

  it('sells on eBay: Depop times out, then is confirmed by read-back; the assisted ones wait for the seller', async () => {
    const listed = await listEverywhere("Levi's trucker jacket");
    // Depop's first mark-sold times out without being applied, so the read-back finds the
    // product still on sale and the delist is sent again.
    depopFake.inject({
      action: 'mark_sold',
      sku: listed.depopSku,
      fault: { type: 'hang', afterApply: false },
    });
    const confirmed = new Set<Marketplace>();
    const watcher = watch(listed, confirmed);

    // The buyer pays on eBay; eBay's ORDER_CONFIRMATION arrives through the webhook.
    const order = ebayFake.sell(listed.ebayItemId);
    const notification = ebayFake.notification('ORDER_CONFIRMATION', {
      user: { userId: FAKE_EBAY_SELLER, username: 'listora_dev_seller' },
      order: {
        orderId: order.orderId,
        orderLineItems: [
          { orderLineItemId: `${order.orderId}-1`, listingId: listed.ebayItemId, quantity: 1 },
        ],
      },
    });
    const payload = JSON.parse(notification.body) as { notification: { notificationId: string } };
    const event = await recordInboundEvent(db, {
      accountId,
      source: 'ebay_webhook',
      marketplace: 'ebay',
      providerEventId: payload.notification.notificationId,
      signatureOk: true,
      payload,
      externalUserId: FAKE_EBAY_SELLER,
    });
    expect(
      await processEbayNotification(
        { db, adapters, endpoints: { api: ebayFake.url }, tokens, logger, timeoutMs: 5_000 },
        { accountId, inboundEventId: event.id },
        signal(),
      ),
    ).toBe('sale_recorded');

    await waitFor(
      async () => byMarketplace(await runOf(listed.itemId))['depop']?.state === 'delisted',
      20_000,
    );
    await waitFor(async () => {
      const results = (await runOf(listed.itemId))?.results ?? [];
      return results.filter((result) => result.state === 'needs_user_action').length === 2;
    });
    let run = await runOf(listed.itemId);
    expect(byMarketplace(run)).toEqual({
      depop: { state: 'delisted', label: 'Marked sold (confirmed by Depop)', mode: 'api' },
      mercari: {
        state: 'needs_user_action',
        label: 'Action needed - delist on Mercari',
        mode: 'assisted',
      },
      poshmark: {
        state: 'needs_user_action',
        label: 'Action needed - delist on Poshmark',
        mode: 'assisted',
      },
    });
    expect(run).toMatchObject({
      soldOn: 'ebay',
      status: 'attention_needed',
      display: { tone: 'action_needed', label: 'Action needed - delist on Mercari and Poshmark' },
    });
    // eBay sold the listing itself: nothing was sent to end it.
    expect(ebayFake.requests.filter((request) => request.action === 'end')).toEqual([]);
    // The timed-out mark-sold was read back before it was sent again, and applied once.
    expect(depopFake.product(listed.depopSku)?.status).toBe('STATUS_MARKED_AS_SOLD');
    expect(
      depopFake.requests
        .filter((request) => request.action === 'mark_sold' && request.sku === listed.depopSku)
        .map((request) => request.applied),
    ).toEqual([false, true]);
    const depopResult = run?.results.find((result) => result.marketplace === 'depop');
    const depopHistory = await db
      .selectFrom('operation_event')
      .select('to_status')
      .where('operation_id', '=', depopResult?.operationId ?? '')
      .orderBy('created_at')
      .execute();
    expect(depopHistory.map((entry) => entry.to_status)).toContain('verifying');
    // The assisted delists are urgent tasks for the seller, with the listing's own page.
    const tasks = await db
      .selectFrom('user_task')
      .select(['kind', 'urgency', 'deep_link', 'delist_run_id'])
      .where('item_id', '=', listed.itemId)
      .orderBy('deep_link')
      .execute();
    expect(tasks).toEqual([
      {
        kind: 'delist_manually',
        urgency: 'urgent',
        deep_link: `https://poshmark.com/listing/${listed.sku}`,
        delist_run_id: run?.id,
      },
      {
        kind: 'delist_manually',
        urgency: 'urgent',
        deep_link: `https://www.mercari.com/us/item/${listed.sku}`,
        delist_run_id: run?.id,
      },
    ]);
    await waitFor(() =>
      Promise.resolve(sender.sent.some((push) => push.data['delistRunId'] === run?.id)),
    );
    expect(sender.sent.find((push) => push.data['delistRunId'] === run?.id)).toMatchObject({
      category: 'item_sold',
      title: 'Sold on eBay',
      body: "Levi's trucker jacket sold on eBay. Listora is delisting it on Depop. Delist it on Mercari and Poshmark now.",
    });

    // The seller delists on Poshmark; Mercari is still open 10 minutes after the sale.
    await confirm(run, 'poshmark', confirmed);
    await sql`update delist_run set created_at = now() - interval '11 minutes' where id = ${run?.id ?? ''}`.execute(
      db,
    );
    expect(await runDelistSla({ db, logger })).toMatchObject({ realerted: 1 });
    await waitFor(() =>
      Promise.resolve(sender.sent.some((push) => push.category === 'delist_reminder')),
    );
    expect(sender.sent.find((push) => push.category === 'delist_reminder')?.body).toBe(
      'It sold on eBay 10 minutes ago. Delist it on Mercari now.',
    );
    run = await runOf(listed.itemId);
    expect(byMarketplace(run)['poshmark']).toEqual({
      state: 'user_confirmed',
      label: 'Done (you confirmed)',
      mode: 'assisted',
    });
    expect(run?.status).toBe('attention_needed');

    await confirm(run, 'mercari', confirmed);
    run = await runOf(listed.itemId);
    expect(run).toMatchObject({ status: 'completed', display: { label: 'Delisted everywhere' } });
    await runDelistSla({ db, logger });
    const item = await db
      .selectFrom('inventory_item')
      .select('status')
      .where('id', '=', listed.itemId)
      .executeTakeFirstOrThrow();
    expect(item.status).toBe('sold');

    await watcher.stop();
    expect(watcher.violations).toEqual([]);
    // The watcher saw Depop pending or being checked before it was confirmed.
    expect(
      [...(watcher.seen.get('depop') ?? [])].some((state) => ALERT_STATES.includes(state as never)),
    ).toBe(true);
  });

  it('sells on Mercari ("Mark sold"): eBay and Depop are ended by API, Poshmark waits for the seller', async () => {
    const listed = await listEverywhere('Vintage Nike windbreaker');
    depopFake.inject({
      action: 'mark_sold',
      sku: listed.depopSku,
      fault: { type: 'timeout_after_send', delayMs: 1_500 },
    });
    const confirmed = new Set<Marketplace>();
    const watcher = watch(listed, confirmed);

    // The seller marks it sold on Mercari in Listora: the same entry point as a detected sale.
    const recorded = await recordSale(
      db,
      {
        accountId,
        marketplace: 'mercari',
        externalOrderId: null,
        soldAt: new Date(),
        currency: 'USD',
        shippingChargedCents: 0,
        detectionSource: 'manual',
        inboundEventId: null,
        shipBy: null,
        lines: [{ itemId: listed.itemId, listingId: null, quantity: 1, priceCents: 4000 }],
      },
      { adapters },
    );
    expect(recorded).toMatchObject({
      type: 'recorded',
      delists: [{ type: 'delist_started', itemId: listed.itemId, delists: 3 }],
    });
    // The sale is tied to the item's Mercari listing.
    const line = await db
      .selectFrom('sale_item')
      .select('listing_id')
      .where('item_id', '=', listed.itemId)
      .executeTakeFirstOrThrow();
    expect(line.listing_id).toBe(listed.listings.mercari);

    await waitFor(async () => {
      const results = byMarketplace(await runOf(listed.itemId));
      return results['ebay']?.state === 'delisted' && results['depop']?.state === 'delisted';
    }, 20_000);
    const run = await runOf(listed.itemId);
    expect(byMarketplace(run)).toEqual({
      depop: { state: 'delisted', label: 'Marked sold (confirmed by Depop)', mode: 'api' },
      ebay: { state: 'delisted', label: 'Delisted (confirmed by eBay)', mode: 'api' },
      poshmark: {
        state: 'needs_user_action',
        label: 'Action needed - delist on Poshmark',
        mode: 'assisted',
      },
    });
    expect(run).toMatchObject({ soldOn: 'mercari', status: 'attention_needed' });
    expect(ebayFake.listing(listed.ebayItemId)?.status).not.toBe('Active');
    // Depop applied the mark-sold but its answer was lost: checked by read-back, never resent.
    expect(
      depopFake.requests.filter(
        (request) => request.action === 'mark_sold' && request.sku === listed.depopSku,
      ),
    ).toHaveLength(1);

    await confirm(run, 'poshmark', confirmed);
    expect(await runOf(listed.itemId)).toMatchObject({ status: 'completed' });
    await watcher.stop();
    expect(watcher.violations).toEqual([]);
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

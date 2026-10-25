/**
 * The delist fan-out against a real Postgres: which listings get which delist, the item lock,
 * moot work canceled, double sales, and idempotency. Nothing runs the operations here; the
 * engine's own tests and the chaos test in `@listora/sales` do.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { enqueueOperation, OPERATION_PRIORITY, OPERATION_TASK } from '@listora/operations';
import { PUSH_TASK } from '@listora/push';
import { orderCancelGuide } from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import { startAutoDelist } from './fan-out.ts';
import { createDelistHarness, type DelistHarness } from './test-support.ts';

describe('the delist fan-out', () => {
  let harness: DelistHarness;
  let ebayConnection: string;
  let depopConnection: string;

  beforeAll(async () => {
    harness = await createDelistHarness('auto_delist_fan_out');
    ebayConnection = await harness.connection('ebay');
    depopConnection = await harness.connection('depop');
  });

  afterAll(async () => {
    await harness.close();
  });

  const fanOut = (
    saleId: string,
    marketplace: 'ebay' | 'depop' | 'poshmark' | 'mercari',
    items: { itemId: string; listingId: string | null }[],
  ) =>
    startAutoDelist(
      harness.db,
      { accountId: harness.accountId, saleId, marketplace, detectionSource: 'webhook', items },
      { adapters: harness.adapters },
    );
  const operations = (delistRunId: string) =>
    harness.db
      .selectFrom('marketplace_operation')
      .selectAll()
      .where('delist_run_id', '=', delistRunId)
      .orderBy('created_at')
      .execute();
  const itemStatus = async (itemId: string) =>
    (
      await harness.db
        .selectFrom('inventory_item')
        .select('status')
        .where('id', '=', itemId)
        .executeTakeFirstOrThrow()
    ).status;

  /** An item listed on all four marketplaces: eBay and Depop by API, the others assisted. */
  async function listedEverywhere() {
    const item = await harness.item("Levi's trucker jacket");
    return {
      item,
      ebay: await harness.listing(item.id, 'ebay', { connectionId: ebayConnection }),
      depop: await harness.listing(item.id, 'depop', { connectionId: depopConnection }),
      poshmark: await harness.listing(item.id, 'poshmark'),
      mercari: await harness.listing(item.id, 'mercari'),
    };
  }

  it('delists every other listing in one transaction: urgent, by capability, and only once', async () => {
    const { item, ebay, depop, poshmark, mercari } = await listedEverywhere();
    // An older Depop listing that ended has nothing to delist.
    await harness.listing(item.id, 'depop', { status: 'ended', connectionId: depopConnection });
    const saleId = await harness.sale('ebay', [{ itemId: item.id, listingId: ebay }]);

    const [start] = await fanOut(saleId, 'ebay', [{ itemId: item.id, listingId: ebay }]);
    expect(start).toMatchObject({ type: 'delist_started', itemId: item.id, delists: 3 });
    if (start?.type !== 'delist_started') throw new Error('no run');
    const runId = start.delistRunId;

    expect(await itemStatus(item.id)).toBe('sold_pending_delist');
    const ops = await operations(runId);
    expect(
      ops.map((op) => [op.listing_id, op.kind, op.desired, op.origin, op.status]).sort(),
    ).toEqual(
      [
        // Depop marks a sale elsewhere sold through its API.
        [depop, 'mark_sold', { status: 'sold' }, 'auto_delist', 'queued'],
        // Assisted marketplaces end; the engine makes each an urgent task when it runs.
        [poshmark, 'end', { status: 'ended' }, 'auto_delist', 'queued'],
        [mercari, 'end', { status: 'ended' }, 'auto_delist', 'queued'],
      ].sort(),
    );
    // Nothing is sent to the listing that sold.
    expect(ops.map((op) => op.listing_id)).not.toContain(ebay);
    // Every delist job runs ahead of routine changes, in its listing's queue.
    const jobs = (await harness.jobs(OPERATION_TASK)).filter((job) =>
      ops.some((op) => job.key === `operation:${op.id}`),
    );
    expect(jobs).toHaveLength(3);
    for (const job of jobs) expect(job.priority).toBe(OPERATION_PRIORITY.urgent);

    // One time-sensitive push says what Listora does and what the seller has to.
    expect(
      (await harness.jobs(PUSH_TASK)).filter((job) => job.key === `push:item_sold:${runId}`),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          category: 'item_sold',
          title: 'Sold on eBay',
          body: "Levi's trucker jacket sold on eBay. Listora is delisting it on Depop. Delist it on Mercari and Poshmark now.",
          urgency: 'time_sensitive',
          data: { itemId: item.id, saleId, delistRunId: runId },
        }) as unknown,
      }),
    ]);
    const audit = await harness.db
      .selectFrom('audit_log')
      .select(['action', 'actor_kind', 'changes'])
      .where('item_id', '=', item.id)
      .execute();
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'item.sold',
        actor_kind: 'marketplace',
        changes: expect.objectContaining({
          saleId,
          status: { from: 'listed', to: 'sold_pending_delist' },
        }) as unknown,
      }),
    ]);

    // Running it again (a retried job, a second delivery) changes nothing.
    expect(await fanOut(saleId, 'ebay', [{ itemId: item.id, listingId: ebay }])).toEqual([
      { type: 'already_started', itemId: item.id, delistRunId: runId },
    ]);
    expect(await operations(runId)).toHaveLength(3);
  });

  it('cancels the work the sale made moot and never publishes the sold item', async () => {
    const item = await harness.item();
    const ebay = await harness.listing(item.id, 'ebay', { connectionId: ebayConnection });
    const depop = await harness.listing(item.id, 'depop', { connectionId: depopConnection });
    const mercari = await harness.listing(item.id, 'mercari', { status: 'draft' });
    const content = sampleListingContent();
    const enqueue = async (listingId: string, input: Parameters<typeof enqueueOperation>[1]) =>
      (await enqueueOperation(harness.db, { ...input, listingId })).operation;
    const base = { accountId: harness.accountId, origin: 'user' as const };
    const ebayRevise = await enqueue(ebay, {
      ...base,
      listingId: ebay,
      idempotencyKey: `revise-${item.id}`,
      kind: 'revise',
      content,
    });
    const depopPrice = await enqueue(depop, {
      ...base,
      listingId: depop,
      idempotencyKey: `price-${item.id}`,
      kind: 'price',
      desired: { priceCents: 3900, currency: 'USD' },
    });
    const mercariCreate = await enqueue(mercari, {
      ...base,
      listingId: mercari,
      idempotencyKey: `create-${item.id}`,
      kind: 'create',
      content,
    });
    const saleId = await harness.sale('ebay', [{ itemId: item.id, listingId: ebay }]);

    const [start] = await fanOut(saleId, 'ebay', [{ itemId: item.id, listingId: ebay }]);
    if (start?.type !== 'delist_started') throw new Error('no run');
    // The Mercari draft was never published, so only Depop needs a delist.
    expect(start.delists).toBe(1);
    expect((await operations(start.delistRunId)).map((op) => op.listing_id)).toEqual([depop]);

    const statuses = await harness.db
      .selectFrom('marketplace_operation')
      .select(['id', 'status'])
      .where('id', 'in', [ebayRevise.id, depopPrice.id, mercariCreate.id])
      .execute();
    expect(statuses.map((op) => op.status)).toEqual(['canceled', 'canceled', 'canceled']);
    const event = await harness.db
      .selectFrom('operation_event')
      .select('detail')
      .where('operation_id', '=', mercariCreate.id)
      .where('to_status', '=', 'canceled')
      .executeTakeFirstOrThrow();
    expect(event.detail).toMatchObject({ action: 'supersede', reason: 'the item sold', saleId });
  });

  it('completes a run with nothing to delist at once, and the item is sold', async () => {
    const item = await harness.item();
    const ebay = await harness.listing(item.id, 'ebay', { connectionId: ebayConnection });
    await harness.listing(item.id, 'poshmark', { status: 'ended' });
    const saleId = await harness.sale('ebay', [{ itemId: item.id, listingId: ebay }]);
    const [start] = await fanOut(saleId, 'ebay', [{ itemId: item.id, listingId: ebay }]);
    expect(start).toMatchObject({ type: 'delist_started', delists: 0 });
    const run = await harness.db
      .selectFrom('delist_run')
      .select(['status', 'completed_at'])
      .where('sale_id', '=', saleId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('completed');
    expect(run.completed_at).toBeInstanceOf(Date);
    expect(await itemStatus(item.id)).toBe('sold');
    // There is nothing for the seller to do, so no push.
    expect(
      (await harness.jobs(PUSH_TASK)).filter(
        (job) => (job.payload['data'] as Record<string, string>)['saleId'] === saleId,
      ),
    ).toEqual([]);
  });

  it('starts one run per item of a bundle', async () => {
    const first = await listedEverywhere();
    const second = await harness.item();
    const secondDepop = await harness.listing(second.id, 'depop', {
      connectionId: depopConnection,
    });
    const items = [
      { itemId: first.item.id, listingId: first.depop },
      { itemId: second.id, listingId: secondDepop },
    ];
    const saleId = await harness.sale('depop', items);
    const starts = await fanOut(saleId, 'depop', items);
    expect(starts).toMatchObject([
      { type: 'delist_started', itemId: first.item.id, delists: 3 },
      { type: 'delist_started', itemId: second.id, delists: 0 },
    ]);
    // eBay has no API mark-sold for a sale elsewhere, so its listing is ended.
    const [run] = starts;
    if (run?.type !== 'delist_started') throw new Error('no run');
    expect(
      (await operations(run.delistRunId)).find((op) => op.listing_id === first.ebay)?.kind,
    ).toBe('end');
  });

  it('opens a double-sale incident, with the cancel steps, for an item that already sold', async () => {
    const { item, ebay, depop } = await listedEverywhere();
    const firstSale = await harness.sale('ebay', [{ itemId: item.id, listingId: ebay }]);
    await fanOut(firstSale, 'ebay', [{ itemId: item.id, listingId: ebay }]);
    const runs = async () =>
      harness.db.selectFrom('delist_run').select('id').where('item_id', '=', item.id).execute();
    expect(await runs()).toHaveLength(1);

    const secondSale = await harness.sale('depop', [{ itemId: item.id, listingId: depop }]);
    const [start] = await fanOut(secondSale, 'depop', [{ itemId: item.id, listingId: depop }]);
    expect(start).toMatchObject({ type: 'double_sale', itemId: item.id, earlierSaleId: firstSale });
    if (start?.type !== 'double_sale') throw new Error('no incident');
    // No second fan-out: the first sale's run delists everything else.
    expect(await runs()).toHaveLength(1);
    const task = await harness.db
      .selectFrom('user_task')
      .selectAll()
      .where('id', '=', start.taskId)
      .executeTakeFirstOrThrow();
    expect(task).toMatchObject({
      kind: 'resolve_double_sale',
      item_id: item.id,
      listing_id: depop,
      sale_id: secondSale,
      urgency: 'urgent',
      status: 'open',
      deep_link: orderCancelGuide('depop').url,
      payload: {
        title: 'Cancel the order on Depop',
        marketplace: 'depop',
        earlierSaleId: firstSale,
        earlierMarketplace: 'ebay',
        steps: [...orderCancelGuide('depop').steps],
      },
    });
    expect(
      (await harness.jobs(PUSH_TASK)).filter((job) => job.key === `push:double_sale:${task.id}`),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          category: 'double_sale',
          body: 'It sold on Depop after it sold on eBay. Cancel one of the orders; Listora has the steps.',
        }) as unknown,
      }),
    ]);

    // Recording the second sale again opens nothing new.
    expect(await fanOut(secondSale, 'depop', [{ itemId: item.id, listingId: depop }])).toEqual([
      { type: 'double_sale', itemId: item.id, earlierSaleId: firstSale, taskId: task.id },
    ]);
    const tasks = await harness.db
      .selectFrom('user_task')
      .select('id')
      .where('kind', '=', 'resolve_double_sale')
      .where('item_id', '=', item.id)
      .execute();
    expect(tasks).toHaveLength(1);
  });

  it('does not count a canceled sale: the next sale delists as usual', async () => {
    const { item, ebay, depop } = await listedEverywhere();
    const canceled = await harness.sale('ebay', [{ itemId: item.id, listingId: ebay }]);
    await harness.db
      .updateTable('sale')
      .set({ status: 'canceled', canceled_at: new Date() })
      .where('id', '=', canceled)
      .execute();
    const saleId = await harness.sale('depop', [{ itemId: item.id, listingId: depop }]);
    expect(await fanOut(saleId, 'depop', [{ itemId: item.id, listingId: depop }])).toMatchObject([
      { type: 'delist_started', delists: 3 },
    ]);
  });

  it('takes two sales of one item that arrive at once one after the other', async () => {
    const { item, ebay, depop } = await listedEverywhere();
    const record = (marketplace: 'ebay' | 'depop', listingId: string) =>
      harness.db.transaction().execute(async (trx) => {
        const sale = await trx
          .insertInto('sale')
          .values({
            account_id: harness.accountId,
            marketplace,
            external_order_id: `race-${marketplace}-${item.id}`,
            sold_at: new Date(),
            detection_source: 'webhook',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('sale_item')
          .values({
            account_id: harness.accountId,
            sale_id: sale.id,
            marketplace,
            item_id: item.id,
            listing_id: listingId,
            sale_price_cents: 4500,
          })
          .execute();
        return startAutoDelist(
          trx,
          {
            accountId: harness.accountId,
            saleId: sale.id,
            marketplace,
            detectionSource: 'webhook',
            items: [{ itemId: item.id, listingId }],
          },
          { adapters: harness.adapters },
        );
      });
    const results = (await Promise.all([record('ebay', ebay), record('depop', depop)])).flat();
    expect(results.map((result) => result.type).sort()).toEqual(['delist_started', 'double_sale']);
    expect(
      await harness.db
        .selectFrom('delist_run')
        .select('id')
        .where('item_id', '=', item.id)
        .execute(),
    ).toHaveLength(1);
  });
});

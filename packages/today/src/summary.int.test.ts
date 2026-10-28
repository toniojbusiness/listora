import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DelistCard, ShipCard, StaleListingCard } from './cards.ts';
import { loadToday } from './summary.ts';
import { createTodayHarness, type TodayHarness } from './test-support.ts';

const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

describe('the Today summary (real Postgres)', () => {
  let harness: TodayHarness;
  const now = () => new Date();
  const ago = (ms: number) => new Date(Date.now() - ms);

  beforeAll(async () => {
    harness = await createTodayHarness('today_summary');
  });

  afterAll(async () => {
    await harness.close();
  });

  it('is all caught up for a new account, with an empty money summary', async () => {
    const accountId = await harness.account();
    const summary = await loadToday(harness.db, accountId, now());
    expect(summary.cards).toEqual([]);
    expect(summary.money.thisWeek).toMatchObject({ sales: 0, salesCents: 0, profitCents: 0 });
    expect(summary.money.lastWeek).toMatchObject({ sales: 0, salesCents: 0, profitCents: 0 });
  });

  describe('ship', () => {
    it('lists each sold item with its ship-by date and storage location, soonest first', async () => {
      const accountId = await harness.account();
      const location = await harness.db
        .insertInto('storage_location')
        .values({ account_id: accountId, code: 'B-12', label: 'Garage shelf 3' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const later = await harness.item(accountId, { status: 'listed', title: 'Later jacket' });
      const sooner = await harness.item(accountId, {
        status: 'listed',
        title: 'Sooner jeans',
        storage_location_id: location.id,
      });
      const undated = await harness.item(accountId, { status: 'listed', title: 'Undated tee' });
      await harness.sale(accountId, 'ebay', [{ itemId: later.id }], {
        shipBy: new Date(Date.now() + 5 * DAY),
      });
      const soonerSale = await harness.sale(accountId, 'ebay', [{ itemId: sooner.id }], {
        shipBy: new Date(Date.now() + 2 * HOUR),
      });
      await harness.sale(accountId, 'poshmark', [{ itemId: undated.id }], { shipBy: null });

      const { cards } = await loadToday(harness.db, accountId, now());
      const ship = cards.filter((card): card is ShipCard => card.kind === 'ship');
      // Equal urgency keeps the soonest ship-by first, and an undated sale last.
      expect(ship.map((card) => card.item.title)).toEqual([
        'Sooner jeans',
        'Later jacket',
        'Undated tee',
      ]);
      expect(ship[0]).toMatchObject({
        id: `ship:${soonerSale.saleItemIds[0] ?? ''}`,
        urgency: 'urgent',
        title: 'Ship Sooner jeans',
        detail: 'Sold on eBay',
        saleId: soonerSale.saleId,
        location: { code: 'B-12', label: 'Garage shelf 3' },
        action: { destination: 'sale', itemId: sooner.id, saleId: soonerSale.saleId },
      });
      // The urgent one leads the whole screen; the others follow by urgency.
      expect(cards[0]?.id).toBe(ship[0]?.id);
    });

    it('drops an item once it is shipped or archived, or its sale is canceled or returned', async () => {
      const accountId = await harness.account();
      const items = await Promise.all(
        ['shipped', 'archived', 'canceled', 'returned', 'kept'].map((title) =>
          harness.item(accountId, { status: 'listed', title }),
        ),
      );
      const sales = [];
      for (const item of items)
        sales.push(await harness.sale(accountId, 'ebay', [{ itemId: item.id }]));
      await harness.setItemStatus(accountId, items[0]?.id ?? '', 'shipped');
      await harness.db
        .updateTable('inventory_item')
        .set({ status: 'archived', pre_archive_status: 'sold' })
        .where('id', '=', items[1]?.id ?? '')
        .execute();
      await harness.db
        .updateTable('sale')
        .set({ status: 'canceled', canceled_at: new Date() })
        .where('id', '=', sales[2]?.saleId ?? '')
        .execute();
      await harness.db
        .updateTable('sale')
        .set({ status: 'returned', returned_at: new Date() })
        .where('id', '=', sales[3]?.saleId ?? '')
        .execute();

      const { cards } = await loadToday(harness.db, accountId, now());
      expect(cards.filter((card) => card.kind === 'ship').map((card) => card.title)).toEqual([
        'Ship kept',
      ]);
    });
  });

  describe('delist', () => {
    it('shows a delist that waits for the seller as urgent, and one Listora runs as high', async () => {
      const accountId = await harness.account();
      const ebay = await harness.connection(accountId, 'ebay');
      const assisted = await harness.item(accountId, { status: 'listed', title: 'Assisted coat' });
      const poshmark = await harness.listing(accountId, assisted.id, 'poshmark');
      const sold = await harness.listing(accountId, assisted.id, 'depop');
      const automatic = await harness.item(accountId, { status: 'listed', title: 'API boots' });
      await harness.listing(accountId, automatic.id, 'ebay', { connectionId: ebay });
      const soldOn = await harness.listing(accountId, automatic.id, 'mercari');
      const first = await harness.sale(accountId, 'depop', [
        { itemId: assisted.id, listingId: sold },
      ]);
      await harness.sale(accountId, 'mercari', [{ itemId: automatic.id, listingId: soldOn }]);
      // The engine hands the assisted delist to the seller (an assisted step waits for them).
      await harness.db
        .updateTable('marketplace_operation')
        .set({ status: 'needs_user_action' })
        .where('listing_id', '=', poshmark)
        .execute();

      const { cards } = await loadToday(harness.db, accountId, now());
      const delists = cards.filter((card): card is DelistCard => card.kind === 'delist');
      expect(delists).toHaveLength(2);
      expect(delists[0]).toMatchObject({
        urgency: 'urgent',
        title: 'Assisted coat sold on Depop',
        detail: 'Action needed - delist on Poshmark',
        status: { tone: 'action_needed' },
        remaining: ['poshmark'],
        saleId: first.saleId,
        action: { label: 'Finish delisting', destination: 'item', itemId: assisted.id },
      });
      expect(delists[1]).toMatchObject({
        urgency: 'high',
        title: 'API boots sold on Mercari',
        status: { tone: 'in_progress' },
        remaining: ['ebay'],
      });
    });

    it('drops a delist once every listing is confirmed delisted', async () => {
      const accountId = await harness.account();
      const item = await harness.item(accountId, { status: 'listed', title: 'Done dress' });
      await harness.listing(accountId, item.id, 'poshmark');
      await harness.sale(accountId, 'ebay', [{ itemId: item.id }]);
      expect(
        (await loadToday(harness.db, accountId, now())).cards.map((card) => card.kind),
      ).toContain('delist');

      // The seller confirms the assisted delist: the operation succeeds by their confirmation.
      await harness.db
        .updateTable('marketplace_operation')
        .set({ status: 'succeeded', success_evidence: 'user_confirmation' })
        .where('account_id', '=', accountId)
        .where('kind', '=', 'end')
        .execute();
      const kinds = (await loadToday(harness.db, accountId, now())).cards.map((card) => card.kind);
      expect(kinds).not.toContain('delist');
    });
  });

  it('asks to reconnect only the connections the seller has to fix', async () => {
    const accountId = await harness.account();
    await harness.connection(accountId, 'ebay', { status: 'reauth_required' });
    await harness.connection(accountId, 'depop', { status: 'degraded' });
    await harness.connection(accountId, 'mercari', { mode: 'assisted', status: 'connected' });
    const { cards } = await loadToday(harness.db, accountId, now());
    expect(cards.map((card) => card.title)).toEqual(['Reconnect eBay']);
  });

  it("never shows Listora's own sale-check problems, which are the owner's to fix", async () => {
    const accountId = await harness.account();
    const automation = async (marketplace: 'depop' | 'mercari') =>
      (
        await harness.db
          .insertInto('marketplace_connection')
          .values({
            account_id: accountId,
            marketplace,
            mode: 'automation',
            status: 'connected',
            token_ciphertext: Buffer.from('sealed session'),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const failing = await automation('depop');
    const overdue = await automation('mercari');
    await harness.db
      .insertInto('sale_check_schedule')
      .values([
        {
          account_id: accountId,
          connection_id: failing,
          marketplace: 'depop',
          next_check_at: ago(HOUR),
          next_reason: 'retry',
          failures_in_a_row: 3,
          last_error_code: 'element_missing',
          last_error_message: "Depop's sold items page has changed, so Listora couldn't read it.",
          health: 'failing',
          unhealthy_since: ago(3 * HOUR),
        },
        {
          account_id: accountId,
          connection_id: overdue,
          marketplace: 'mercari',
          next_check_at: ago(DAY),
          next_reason: 'scheduled',
          health: 'overdue',
          unhealthy_since: ago(DAY),
        },
      ])
      .execute();
    const summary = await loadToday(harness.db, accountId, now());
    expect(summary.cards).toEqual([]);
  });

  it('counts the drafts into one card', async () => {
    const accountId = await harness.account();
    await harness.item(accountId, { status: 'draft' });
    await harness.item(accountId, { status: 'draft' });
    await harness.item(accountId, { status: 'ready' });
    const { cards } = await loadToday(harness.db, accountId, now());
    expect(cards).toMatchObject([{ kind: 'review_drafts', count: 2, title: '2 drafts to review' }]);
  });

  describe('stale listings', () => {
    it('suggests a price drop above the floor for an old listing with no recent change', async () => {
      const accountId = await harness.account();
      const stale = await harness.item(accountId, {
        status: 'listed',
        title: 'Old sweater',
        list_price_cents: 4500,
        floor_price_cents: 3500,
      });
      const ebayListing = await harness.listing(accountId, stale.id, 'ebay', {
        listedAt: ago(40 * DAY),
      });
      await harness.listing(accountId, stale.id, 'depop', { listedAt: ago(35 * DAY) });
      await harness.operation(accountId, ebayListing, 'price', ago(20 * DAY));

      const recentlyChanged = await harness.item(accountId, {
        status: 'listed',
        list_price_cents: 3000,
      });
      const changed = await harness.listing(accountId, recentlyChanged.id, 'ebay', {
        listedAt: ago(60 * DAY),
      });
      await harness.operation(accountId, changed, 'price', ago(3 * DAY));

      const young = await harness.item(accountId, { status: 'listed', list_price_cents: 3000 });
      await harness.listing(accountId, young.id, 'ebay', { listedAt: ago(10 * DAY) });

      const ended = await harness.item(accountId, { status: 'listed', list_price_cents: 3000 });
      await harness.listing(accountId, ended.id, 'ebay', {
        status: 'ended',
        listedAt: ago(60 * DAY),
      });

      const { cards } = await loadToday(harness.db, accountId, now());
      const staleCards = cards.filter(
        (card): card is StaleListingCard => card.kind === 'stale_listing',
      );
      expect(staleCards).toHaveLength(1);
      expect(staleCards[0]).toMatchObject({
        title: 'Old sweater',
        daysListed: 40,
        priceCents: 4500,
        floorCents: 3500,
        suggestion: { kind: 'price_drop', priceCents: 4000 },
        marketplaces: ['depop', 'ebay'],
        action: { label: 'Lower to $40', destination: 'item', itemId: stale.id },
      });
    });

    it('uses the lowest listing price when the item has none, and shows at most five', async () => {
      const accountId = await harness.account();
      for (let index = 0; index < 7; index += 1) {
        const item = await harness.item(accountId, { status: 'listed', floor_price_cents: 1000 });
        await harness.listing(accountId, item.id, 'ebay', {
          listedAt: ago((40 + index) * DAY),
          priceCents: 2000 + index,
        });
      }
      const { cards } = await loadToday(harness.db, accountId, now());
      const staleCards = cards.filter(
        (card): card is StaleListingCard => card.kind === 'stale_listing',
      );
      expect(staleCards).toHaveLength(5);
      // Longest listed first.
      expect(staleCards.map((card) => card.daysListed)).toEqual([46, 45, 44, 43, 42]);
      expect(staleCards[0]?.priceCents).toBe(2006);
    });
  });

  it('sums this week and last week, profit only where fees and costs are known', async () => {
    const accountId = await harness.account();
    const costed = await harness.item(accountId, { status: 'listed', cost_cents: 1200 });
    const uncosted = await harness.item(accountId, { status: 'listed' });
    const lastWeek = await harness.item(accountId, { status: 'listed', cost_cents: 500 });
    const canceled = await harness.item(accountId, { status: 'listed', cost_cents: 100 });
    const known = await harness.sale(accountId, 'ebay', [{ itemId: costed.id, priceCents: 4000 }], {
      soldAt: ago(DAY),
      shippingCents: 500,
    });
    await harness.db
      .insertInto('fee_line')
      .values([
        {
          account_id: accountId,
          sale_id: known.saleId,
          kind: 'marketplace',
          amount_cents: 520,
          source: 'actual',
        },
        {
          account_id: accountId,
          sale_id: known.saleId,
          kind: 'payment',
          amount_cents: 130,
          source: 'actual',
        },
      ])
      .execute();
    await harness.sale(accountId, 'poshmark', [{ itemId: uncosted.id, priceCents: 2500 }], {
      soldAt: ago(2 * DAY),
    });
    const previous = await harness.sale(
      accountId,
      'ebay',
      [{ itemId: lastWeek.id, priceCents: 3000 }],
      {
        soldAt: ago(9 * DAY),
      },
    );
    await harness.db
      .insertInto('fee_line')
      .values({
        account_id: accountId,
        sale_id: previous.saleId,
        kind: 'marketplace',
        amount_cents: 400,
        source: 'estimated',
      })
      .execute();
    const undone = await harness.sale(
      accountId,
      'ebay',
      [{ itemId: canceled.id, priceCents: 9900 }],
      {
        soldAt: ago(DAY),
      },
    );
    await harness.db
      .updateTable('sale')
      .set({ status: 'canceled', canceled_at: new Date() })
      .where('id', '=', undone.saleId)
      .execute();

    // A shipped sale still counts, minus its label cost.
    const labeled = await harness.item(accountId, { status: 'listed', cost_cents: 300 });
    const shippedSale = await harness.sale(
      accountId,
      'ebay',
      [{ itemId: labeled.id, priceCents: 2000 }],
      { soldAt: ago(3 * DAY) },
    );
    await harness.db
      .updateTable('sale')
      .set({ status: 'shipped', shipped_at: ago(2 * DAY), shipping_cost_cents: 450 })
      .where('id', '=', shippedSale.saleId)
      .execute();
    await harness.db
      .insertInto('fee_line')
      .values({
        account_id: accountId,
        sale_id: shippedSale.saleId,
        kind: 'marketplace',
        amount_cents: 260,
        source: 'actual',
      })
      .execute();

    const { money } = await loadToday(harness.db, accountId, now());
    expect(money.thisWeek).toMatchObject({
      sales: 3,
      itemsSold: 3,
      salesCents: 8500,
      profitCents: 4000 + 500 - 520 - 130 - 1200 + (2000 - 260 - 450 - 300),
      profitPendingSales: 1,
    });
    expect(money.lastWeek).toMatchObject({
      sales: 1,
      salesCents: 3000,
      profitCents: 3000 - 400 - 500,
      profitPendingSales: 0,
    });
  });

  it("never shows another account's work", async () => {
    const accountId = await harness.account();
    const other = await harness.account('OT');
    const item = await harness.item(other, { status: 'listed' });
    await harness.sale(other, 'ebay', [{ itemId: item.id }]);
    await harness.item(other, { status: 'draft' });
    await harness.connection(other, 'ebay', { status: 'revoked' });
    const summary = await loadToday(harness.db, accountId, now());
    expect(summary.cards).toEqual([]);
    expect(summary.money.thisWeek.sales).toBe(0);
  });
});

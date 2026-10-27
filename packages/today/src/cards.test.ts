import type { DelistResult, DelistRunView } from '@listora/auto-delist';
import { describe, expect, it } from 'vitest';

import {
  delistCard,
  formatMoney,
  isStale,
  orderCards,
  reconnectCard,
  reviewDraftsCard,
  saleChecksCard,
  shipCard,
  shipUrgency,
  staleListingCard,
  staleSuggestion,
  TODAY_RULES,
  type ListedFact,
  type ShipFact,
  type TodayCard,
} from './cards.ts';

const NOW = new Date('2026-10-25T15:00:00.000Z');
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const later = (ms: number) => new Date(NOW.getTime() + ms);
const item = { id: 'item-1', sku: 'AJ-000001', title: "Levi's 501 jeans" };

describe('ship cards', () => {
  const fact: ShipFact = {
    saleId: 'sale-1',
    saleItemId: 'sale-item-1',
    marketplace: 'ebay',
    soldAt: ago(3 * HOUR),
    shipBy: later(2 * DAY),
    item,
    location: { code: 'B-12', label: 'Garage shelf' },
  };

  it('says what to ship, where it sold, and where it is kept, and opens the item', () => {
    expect(shipCard(fact, NOW)).toEqual({
      kind: 'ship',
      id: 'ship:sale-item-1',
      urgency: 'high',
      title: "Ship Levi's 501 jeans",
      detail: 'Sold on eBay',
      action: {
        label: 'Open sale',
        destination: 'sale',
        itemId: 'item-1',
        saleId: 'sale-1',
        connectionId: null,
      },
      item,
      saleId: 'sale-1',
      marketplace: 'ebay',
      soldAt: fact.soldAt,
      shipBy: fact.shipBy,
      location: { code: 'B-12', label: 'Garage shelf' },
    });
  });

  it('names an untitled item by its SKU', () => {
    expect(shipCard({ ...fact, item: { ...item, title: '  ' } }, NOW).title).toBe('Ship AJ-000001');
  });

  it.each([
    ['past its ship-by date', ago(HOUR), 'urgent'],
    ['due within a day', later(TODAY_RULES.shipUrgentWithinMs), 'urgent'],
    ['due within three days', later(TODAY_RULES.shipSoonWithinMs), 'high'],
    ['due later', later(TODAY_RULES.shipSoonWithinMs + 1), 'normal'],
  ] as const)('is %s: %s', (_, shipBy, urgency) => {
    expect(shipUrgency({ shipBy, soldAt: ago(HOUR) }, NOW)).toBe(urgency);
  });

  it('is high once a sale without a ship-by date is two days old', () => {
    expect(shipUrgency({ shipBy: null, soldAt: ago(DAY) }, NOW)).toBe('normal');
    expect(
      shipUrgency({ shipBy: null, soldAt: ago(TODAY_RULES.shipUndatedHighAfterMs) }, NOW),
    ).toBe('high');
  });
});

describe('delist cards', () => {
  const result = (marketplace: DelistResult['marketplace'], state: DelistResult['state']) =>
    ({ marketplace, state }) as DelistResult;
  const run = (overrides: Partial<DelistRunView>): DelistRunView =>
    ({
      id: 'run-1',
      saleId: 'sale-1',
      itemId: 'item-1',
      soldOn: 'ebay',
      saleStatus: 'detected',
      status: 'attention_needed',
      display: { tone: 'action_needed', label: 'Action needed - delist on Poshmark' },
      results: [result('depop', 'delisted'), result('poshmark', 'needs_user_action')],
      ...overrides,
    }) as DelistRunView;

  it('is urgent while the seller has to act, with the run summary and what is left', () => {
    expect(delistCard(run({}), item)).toMatchObject({
      kind: 'delist',
      id: 'delist:run-1',
      urgency: 'urgent',
      title: "Levi's 501 jeans sold on eBay",
      detail: 'Action needed - delist on Poshmark',
      action: { label: 'Finish delisting', destination: 'item', itemId: 'item-1' },
      status: { tone: 'action_needed', label: 'Action needed - delist on Poshmark' },
      remaining: ['poshmark'],
    });
  });

  it('is high while Listora is still delisting', () => {
    const card = delistCard(
      run({
        status: 'in_progress',
        display: { tone: 'in_progress', label: 'Delisting on Depop...' },
        results: [result('depop', 'pending'), result('mercari', 'user_confirmed')],
      }),
      item,
    );
    expect(card).toMatchObject({
      urgency: 'high',
      detail: 'Delisting on Depop...',
      action: { label: 'View delisting' },
      remaining: ['depop'],
    });
  });

  it('is gone once the run is done everywhere, or its sale was undone', () => {
    expect(delistCard(run({ status: 'completed' }), item)).toBeNull();
    expect(delistCard(run({ saleStatus: 'canceled' }), item)).toBeNull();
    expect(delistCard(run({ saleStatus: 'returned' }), item)).toBeNull();
  });
});

describe('reconnect cards', () => {
  it('asks to reconnect a connection the marketplace stopped accepting, on the connections screen', () => {
    expect(
      reconnectCard({
        id: 'conn-1',
        marketplace: 'ebay',
        displayName: 'seller1',
        status: 'reauth_required',
      }),
    ).toEqual({
      kind: 'reconnect',
      id: 'reconnect:conn-1',
      urgency: 'high',
      title: 'Reconnect eBay',
      detail:
        "eBay stopped accepting Listora's access. Reconnect so Listora can keep your listings there in sync.",
      action: {
        label: 'Reconnect',
        destination: 'marketplaces',
        itemId: null,
        saleId: null,
        connectionId: 'conn-1',
      },
      connectionId: 'conn-1',
      marketplace: 'ebay',
      displayName: 'seller1',
      status: 'reauth_required',
    });
  });

  it('says when access was removed', () => {
    const card = reconnectCard({
      id: 'c',
      marketplace: 'depop',
      displayName: null,
      status: 'revoked',
    });
    expect(card.detail).toBe(
      "Listora's access to Depop was removed. Reconnect so Listora can keep your listings there in sync.",
    );
  });
});

describe('stale listings', () => {
  const fact: ListedFact = {
    item,
    currency: 'USD',
    priceCents: 4500,
    floorCents: 3500,
    listedAt: ago(45 * DAY),
    lastChangeAt: ago(20 * DAY),
    marketplaces: ['ebay', 'poshmark'],
  };

  it('is stale after 30 days live with no change for 14', () => {
    expect(isStale(fact, NOW)).toBe(true);
    expect(isStale({ ...fact, lastChangeAt: null }, NOW)).toBe(true);
    expect(isStale({ ...fact, listedAt: ago(TODAY_RULES.staleListedDays * DAY - 1) }, NOW)).toBe(
      false,
    );
    expect(isStale({ ...fact, lastChangeAt: ago(TODAY_RULES.staleQuietDays * DAY - 1) }, NOW)).toBe(
      false,
    );
  });

  it('suggests 10% off in whole dollars, never below the floor', () => {
    expect(staleSuggestion(4500, 3500)).toEqual({ kind: 'price_drop', priceCents: 4000 });
    expect(staleSuggestion(4500, 4200)).toEqual({ kind: 'price_drop', priceCents: 4200 });
    expect(staleSuggestion(999, 0)).toEqual({ kind: 'price_drop', priceCents: 800 });
  });

  it('suggests a relist when no price drop is possible or no floor is known', () => {
    expect(staleSuggestion(3500, 3500)).toEqual({ kind: 'relist' });
    expect(staleSuggestion(3000, 3500)).toEqual({ kind: 'relist' });
    expect(staleSuggestion(4500, null)).toEqual({ kind: 'relist' });
  });

  it.each([
    [4500, 3500],
    [4500, 4499],
    [12_345, 11_111],
    [101, 100],
    [100, 1],
  ])('never suggests below the floor: %i with floor %i', (price, floor) => {
    const suggestion = staleSuggestion(price, floor);
    if (suggestion.kind === 'price_drop') {
      expect(suggestion.priceCents).toBeGreaterThanOrEqual(floor);
      expect(suggestion.priceCents).toBeLessThan(price);
    }
  });

  it('offers the price drop as the action, on the item', () => {
    expect(staleListingCard(fact, NOW)).toEqual({
      kind: 'stale_listing',
      id: 'stale:item-1',
      urgency: 'normal',
      title: "Levi's 501 jeans",
      detail: 'Listed 45 days with no changes. Try $40, still above your $35 floor.',
      action: {
        label: 'Lower to $40',
        destination: 'item',
        itemId: 'item-1',
        saleId: null,
        connectionId: null,
      },
      item,
      listedAt: fact.listedAt,
      daysListed: 45,
      currency: 'USD',
      priceCents: 4500,
      floorCents: 3500,
      suggestion: { kind: 'price_drop', priceCents: 4000 },
      marketplaces: ['ebay', 'poshmark'],
    });
  });

  it('offers a relist at the floor, or without one', () => {
    expect(staleListingCard({ ...fact, priceCents: 3500 }, NOW)).toMatchObject({
      detail:
        "Listed 45 days with no changes. It's at its floor price, so relisting can bring it back to the top of search.",
      action: { label: 'Review listing' },
      suggestion: { kind: 'relist' },
    });
    expect(staleListingCard({ ...fact, floorCents: null }, NOW)?.detail).toBe(
      'Listed 45 days with no changes. Relisting can bring it back to the top of search.',
    );
  });

  it('has no card for a listing that is not stale or has no price', () => {
    expect(staleListingCard({ ...fact, lastChangeAt: ago(DAY) }, NOW)).toBeNull();
    expect(staleListingCard({ ...fact, priceCents: null }, NOW)).toBeNull();
  });
});

describe('drafts', () => {
  it('is one card for every draft, which opens the drafts', () => {
    expect(reviewDraftsCard({ count: 3, oldestCreatedAt: ago(DAY) })).toEqual({
      kind: 'review_drafts',
      id: 'review_drafts',
      urgency: 'normal',
      title: '3 drafts to review',
      detail: "Check their details and prices, and they're ready to list everywhere.",
      action: {
        label: 'Review drafts',
        destination: 'drafts',
        itemId: null,
        saleId: null,
        connectionId: null,
      },
      count: 3,
      oldestCreatedAt: ago(DAY),
    });
    expect(reviewDraftsCard({ count: 1, oldestCreatedAt: ago(DAY) })?.title).toBe(
      '1 draft to review',
    );
    expect(reviewDraftsCard({ count: 0, oldestCreatedAt: null })).toBeNull();
  });
});

describe('order', () => {
  it('puts the most urgent first, then by kind, keeping each kind in its own order', () => {
    const card = (id: string, kind: TodayCard['kind'], urgency: TodayCard['urgency']) =>
      ({ id, kind, urgency }) as TodayCard;
    const ordered = orderCards([
      card('stale', 'stale_listing', 'normal'),
      card('ship-later', 'ship', 'normal'),
      card('drafts', 'review_drafts', 'normal'),
      card('reconnect', 'reconnect', 'high'),
      card('ship-first', 'ship', 'urgent'),
      card('ship-second', 'ship', 'urgent'),
      card('delist', 'delist', 'urgent'),
    ]);
    expect(ordered.map((c) => c.id)).toEqual([
      'delist',
      'ship-first',
      'ship-second',
      'reconnect',
      'ship-later',
      'drafts',
      'stale',
    ]);
  });
});

describe('formatMoney', () => {
  it('drops the cents of whole dollars', () => {
    expect(formatMoney(4000)).toBe('$40');
    expect(formatMoney(4050)).toBe('$40.50');
    expect(formatMoney(123_400)).toBe('$1,234');
  });
});

describe('sale-check cards', () => {
  it("says a marketplace's sales are not being seen, why, and opens its connection", () => {
    const card = saleChecksCard(
      {
        connectionId: 'conn-2',
        marketplace: 'depop',
        health: 'failing',
        failuresInARow: 2,
        lastErrorMessage: "Depop's sold items page has changed, so Listora couldn't read it.",
        lastSucceededAt: null,
        unhealthySince: ago(3 * HOUR),
        runsOn: 'phone',
      },
      NOW,
    );
    expect(card).toEqual({
      kind: 'sale_checks',
      id: 'sale_checks:conn-2',
      urgency: 'high',
      title: "Listora can't check Depop for sales",
      detail:
        "The last 2 checks failed: Depop's sold items page has changed, so Listora couldn't " +
        'read it. Listora keeps trying. Until it can, a sale on Depop is not delisted elsewhere ' +
        'automatically.',
      action: {
        label: 'See marketplaces',
        destination: 'marketplaces',
        itemId: null,
        saleId: null,
        connectionId: 'conn-2',
      },
      connectionId: 'conn-2',
      marketplace: 'depop',
      health: 'failing',
      since: ago(3 * HOUR),
      lastSucceededAt: null,
    });
    // After a reconnect card of the same urgency, before drafts.
    const reconnect = reconnectCard({
      id: 'conn-1',
      marketplace: 'ebay',
      displayName: null,
      status: 'revoked',
    });
    expect(orderCards([card, reconnect]).map((ordered) => ordered.kind)).toEqual([
      'reconnect',
      'sale_checks',
    ]);
  });
});

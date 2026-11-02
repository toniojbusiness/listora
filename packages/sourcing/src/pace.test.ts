import { claimsSoldData, MARKET_SOLD_LABEL_PREFIX } from '@listora/pricing';
import { describe, expect, it } from 'vitest';

import { latestSoldPace, marketRecentSoldPace, marketSoldPace } from './pace.ts';

describe('marketSoldPace', () => {
  it("reads a search's sold count against its supply: fast, steady, or slow", () => {
    expect(marketSoldPace(410, 320, 90, 'eBay')).toEqual({
      demand: 'strong',
      label: 'Sells fast on eBay',
      basedOn: 'Sold listings on eBay: 410 in the last 90 days; 320 for sale now',
    });
    expect(marketSoldPace(1_200, 2_400, 90, 'eBay')).toEqual({
      demand: 'steady',
      basedOn: 'Sold listings on eBay: 1,200 in the last 90 days; 2,400 for sale now',
    });
    expect(marketSoldPace(50, 400, 90, 'eBay')).toMatchObject({
      demand: 'crowded',
      label: 'Slow on eBay',
    });
    expect(marketSoldPace(3, 0, 90, 'eBay').demand).toBe('strong');
  });

  it('says nothing without both counts', () => {
    expect(marketSoldPace(null, 40, 90, 'eBay')).toEqual({
      demand: 'unknown',
      basedOn: 'eBay gave no count of its sales',
    });
    expect(marketSoldPace(40, null, 90, 'eBay').demand).toBe('unknown');
  });

  it('words sold data only under the sold listings label', () => {
    const { basedOn } = marketSoldPace(410, 320, 90, 'eBay');
    expect(claimsSoldData(basedOn)).toBe(true);
    expect(basedOn.startsWith(MARKET_SOLD_LABEL_PREFIX)).toBe(true);
    // Without the numbers it says nothing of sold data, so a row of asking prices may carry it.
    expect(claimsSoldData(marketSoldPace(null, 40, 90, 'eBay').basedOn)).toBe(false);
  });
});

describe('latestSoldPace', () => {
  it("reads how many of Mercari's latest sales were lately: fast, steady, or slow", () => {
    expect(latestSoldPace(24, 30, 30, 'Mercari')).toEqual({
      demand: 'strong',
      label: 'Sells fast on Mercari',
      basedOn: 'Sold listings on Mercari: 24 of the latest 30 sold in the last 30 days',
    });
    expect(latestSoldPace(20, 30, 30, 'Mercari').demand).toBe('strong');
    expect(latestSoldPace(12, 30, 30, 'Mercari')).toEqual({
      demand: 'steady',
      basedOn: 'Sold listings on Mercari: 12 of the latest 30 sold in the last 30 days',
    });
    expect(latestSoldPace(7, 28, 30, 'Mercari')).toMatchObject({
      demand: 'crowded',
      label: 'Slow on Mercari',
    });
    expect(latestSoldPace(0, 30, 30, 'Mercari').demand).toBe('crowded');
  });

  it('says nothing without dates or with too few sales, and never says sold then', () => {
    const undated = latestSoldPace(null, 30, 30, 'Mercari');
    expect(undated).toEqual({
      demand: 'unknown',
      basedOn: 'Mercari gave no dates for its latest sales',
    });
    const few = latestSoldPace(4, 4, 30, 'Mercari');
    expect(few.demand).toBe('unknown');
    for (const read of [undated, few]) expect(claimsSoldData(read.basedOn)).toBe(false);
  });

  it('never counts more lately than it read', () => {
    expect(latestSoldPace(40, 30, 30, 'Mercari').basedOn).toBe(
      'Sold listings on Mercari: 30 of the latest 30 sold in the last 30 days',
    );
  });
});

describe('marketRecentSoldPace', () => {
  const pace = (soldCount: number, windowDays: number | null, forSaleCount = 6) =>
    marketRecentSoldPace({ soldCount, windowDays, forSaleCount, forSaleTotal: 97_581 }, 'Poshmark');

  it('reads how many close matches sold a month: fast, steady, or slow', () => {
    expect(pace(14, 42)).toEqual({
      demand: 'strong',
      label: 'Sells fast on Poshmark',
      basedOn: 'Sold listings on Poshmark: 14 like it in the last 42 days; 97,581 for sale now',
    });
    expect(pace(5, 60)).toEqual({
      demand: 'steady',
      basedOn: 'Sold listings on Poshmark: 5 like it in the last 60 days; 97,581 for sale now',
    });
    expect(pace(2, 88)).toMatchObject({ demand: 'crowded', label: 'Slow on Poshmark' });
    expect(pace(0, null)).toEqual({
      demand: 'crowded',
      label: 'Slow on Poshmark',
      basedOn: 'Sold listings on Poshmark: none like it in the last 30 days; 97,581 for sale now',
    });
  });

  it('never reads a burst of a few days as more than a month of them', () => {
    expect(pace(7, 3)).toMatchObject({
      demand: 'steady',
      basedOn: expect.stringContaining('7 like it in the last 30 days') as string,
    });
    expect(pace(8, 3).demand).toBe('strong');
  });

  it('calls few sales slow only while close matches are for sale', () => {
    expect(pace(0, null, 2).demand).toBe('steady');
    expect(
      marketRecentSoldPace(
        { soldCount: 3, windowDays: 40, forSaleCount: 0, forSaleTotal: null },
        'Poshmark',
      ).basedOn,
    ).toBe('Sold listings on Poshmark: 3 like it in the last 40 days');
  });

  it('words sold data only under the sold listings label', () => {
    const { basedOn } = pace(14, 42);
    expect(claimsSoldData(basedOn)).toBe(true);
    expect(basedOn.startsWith(MARKET_SOLD_LABEL_PREFIX)).toBe(true);
  });
});

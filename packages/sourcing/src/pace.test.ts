import { claimsSoldData, MARKET_SOLD_LABEL_PREFIX } from '@listora/pricing';
import { describe, expect, it } from 'vitest';

import { marketSoldPace } from './pace.ts';

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
      basedOn: 'eBay gave no count of sold listings',
    });
    expect(marketSoldPace(40, null, 90, 'eBay').demand).toBe('unknown');
  });

  it('words sold data only under the sold listings label', () => {
    const { basedOn } = marketSoldPace(410, 320, 90, 'eBay');
    expect(claimsSoldData(basedOn)).toBe(true);
    expect(basedOn.startsWith(MARKET_SOLD_LABEL_PREFIX)).toBe(true);
  });
});

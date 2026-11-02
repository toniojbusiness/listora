import {
  AI_ESTIMATE_LABEL,
  ASKING_PRICES_LABEL,
  claimsSoldData,
  MARKET_SOLD_LABEL_PREFIX,
} from '@listora/pricing';
import { describe, expect, it } from 'vitest';

import {
  brandPulseSignal,
  callWhy,
  DEFAULT_SCAN_CALL_SETTINGS,
  pricesSignal,
  scanCall,
  type ScanCallInput,
  type ScanCallSettings,
} from './call.ts';
import type { MatchLevel, OwnHistoryComparisons } from './own-history.ts';

const settings: ScanCallSettings = { ...DEFAULT_SCAN_CALL_SETTINGS, worthListingCents: 1_000 };
const NO_FLAGS = { visibleDamage: false, lotOrBundle: false, counterfeitProne: false };
/** A flat 10% fee keeps the payouts easy to read. */
const tenPercent = (priceCents: number) => Math.round(priceCents / 10);

function history(
  lowCents: number,
  highCents: number,
  count = 5,
  level: MatchLevel = 'brand_and_category',
): OwnHistoryComparisons {
  return {
    level,
    saleIds: Array.from({ length: count }, (_, index) => `s${String(index)}`),
    prices: { count, lowCents, medianCents: Math.round((lowCents + highCents) / 2), highCents },
  };
}

function input(overrides: Partial<ScanCallInput>): ScanCallInput {
  return { identityConfidence: 0.9, flags: NO_FLAGS, fees: tenPercent, ...overrides };
}

describe('scanCall with marketplace comparisons', () => {
  const asking = { count: 6, lowCents: 1_500, highCents: 2_500 };

  it("holds the AI's guess to what close matches ask, saying so under the asking label", () => {
    const call = scanCall(
      input({
        aiEstimate: { lowCents: 2_000, midCents: 3_000, highCents: 4_000 },
        markets: [{ marketplace: 'Depop', asking }],
      }),
      settings,
    );
    expect(call.basis).toBe('ai_estimate');
    expect(call.range).toEqual({ lowCents: 2_000, highCents: 2_500 });
    expect(call.signals).toContainEqual({
      kind: 'asking',
      label: 'Asking $15-$25 on Depop',
      basedOn: `${ASKING_PRICES_LABEL}: 6 like it for sale on Depop; the range is held to them`,
    });
  });

  it("never moves a range from the household's own sales, and needs enough matches", () => {
    const own = scanCall(
      input({ ownHistory: history(3_000, 5_000), markets: [{ marketplace: 'Depop', asking }] }),
      settings,
    );
    expect(own.range).toEqual({ lowCents: 3_000, highCents: 5_000 });
    expect(own.signals[0]?.basedOn).toBe(`${ASKING_PRICES_LABEL}: 6 like it for sale on Depop`);
    const thin = scanCall(
      input({
        aiEstimate: { lowCents: 2_000, midCents: 3_000, highCents: 4_000 },
        markets: [{ marketplace: 'Depop', asking: { ...asking, count: 4 } }],
      }),
      settings,
    );
    expect(thin.range).toEqual({ lowCents: 2_000, highCents: 4_000 });
    expect(thin.signals).toEqual([]);
  });

  it('shows the demand as a signal that moves no call', () => {
    const call = scanCall(
      input({
        ownHistory: history(1_200, 2_000),
        markets: [
          {
            marketplace: 'Depop',
            demand: { demand: 'crowded', label: 'Crowded on Depop', basedOn: 'Your 0 sales...' },
          },
        ],
      }),
      settings,
    );
    expect(call).toMatchObject({ call: 'buy', confidence: 'high' });
    expect(call.signals).toContainEqual({
      kind: 'demand',
      label: 'Crowded on Depop',
      basedOn: 'Your 0 sales...',
    });
    const strong = scanCall(
      input({
        ownHistory: history(1_200, 2_000),
        markets: [
          {
            marketplace: 'Depop',
            demand: { demand: 'strong', label: 'Sells for you, little competition', basedOn: 'x' },
          },
        ],
      }),
      settings,
    );
    expect(strong).toMatchObject({ call: 'buy', confidence: 'high' });
  });
});

describe("scanCall with a marketplace's sold listings", () => {
  const ebaySold = (count: number, level: 'model' | 'type' = 'model') => ({
    marketplace: 'eBay',
    sold: { count, lowCents: 1_800, highCents: 3_000, windowDays: 14, level },
  });
  const ai = { lowCents: 4_000, midCents: 5_000, highCents: 6_000 };

  it("rests on close matches' sold prices before the web or the AI, saying so", () => {
    const call = scanCall(input({ aiEstimate: ai, markets: [ebaySold(6)] }), settings);
    expect(call).toMatchObject({
      call: 'buy',
      confidence: 'medium',
      basis: 'market_sold',
      range: { lowCents: 1_800, highCents: 3_000 },
      basedOn: 'Sold listings on eBay: 6 like it in the last 14 days',
    });
    expect(call.basedOn.startsWith(MARKET_SOLD_LABEL_PREFIX)).toBe(true);
  });

  it("yields to the household's own sales, and needs enough sold matches", () => {
    const own = scanCall(
      input({ ownHistory: history(1_200, 2_000), markets: [ebaySold(12)] }),
      settings,
    );
    expect(own).toMatchObject({ basis: 'own_history', range: { lowCents: 1_200 } });
    const thin = scanCall(input({ aiEstimate: ai, markets: [ebaySold(4)] }), settings);
    expect(thin).toMatchObject({ basis: 'ai_estimate', confidence: 'low' });
  });

  it('is high confidence only with many sold of the exact model and a sure read', () => {
    expect(scanCall(input({ markets: [ebaySold(10)] }), settings).confidence).toBe('high');
    expect(scanCall(input({ markets: [ebaySold(10, 'type')] }), settings).confidence).toBe(
      'medium',
    );
    expect(
      scanCall(input({ identityConfidence: 0.7, markets: [ebaySold(10)] }), settings).confidence,
    ).toBe('medium');
    expect(
      scanCall(input({ identityConfidence: 0.5, markets: [ebaySold(10)] }), settings),
    ).toMatchObject({ call: 'your_call', confidence: 'low' });
  });

  it("keeps a call from high confidence where the marketplace's sold pace reads slow", () => {
    const slow = {
      ...ebaySold(10),
      demand: {
        demand: 'crowded' as const,
        label: 'Slow on eBay',
        basedOn: 'Sold listings on eBay: 20 in the last 90 days; 400 for sale now',
        fromSoldPace: true,
      },
    };
    const call = scanCall(input({ markets: [slow] }), settings);
    expect(call).toMatchObject({ call: 'buy', confidence: 'medium' });
    expect(call.signals).toContainEqual({
      kind: 'demand',
      label: 'Slow on eBay',
      basedOn: 'Sold listings on eBay: 20 in the last 90 days; 400 for sale now',
    });
    const fast = { ...slow, demand: { ...slow.demand, demand: 'strong' as const } };
    expect(scanCall(input({ markets: [fast] }), settings).confidence).toBe('high');
  });

  it("holds the AI's guess to the first marketplace with enough asking prices, Depop first", () => {
    const call = scanCall(
      input({
        aiEstimate: ai,
        markets: [
          { marketplace: 'Depop', asking: { count: 6, lowCents: 1_500, highCents: 2_500 } },
          { marketplace: 'eBay', asking: { count: 9, lowCents: 2_000, highCents: 3_500 } },
        ],
      }),
      settings,
    );
    expect(call.range).toEqual({ lowCents: 2_500, highCents: 2_500 });
  });
});

describe('scanCall', () => {
  it('buys when even the low quartile pays out the worth-listing amount', () => {
    expect(scanCall(input({ ownHistory: history(1_200, 2_000) }), settings)).toEqual({
      call: 'buy',
      confidence: 'high',
      basis: 'own_history',
      range: { lowCents: 1_200, highCents: 2_000 },
      conservativePayoutCents: 1_080,
      optimisticPayoutCents: 1_800,
      basedOn: 'Your 5 sales like it',
      prices: {
        listAtCents: 2_500,
        realisticCents: 1_600,
        fastCents: 1_200,
        basedOn:
          'Likely sale is the middle of your sales like it, fast sale its low end; list at leaves room for offers (items usually go for about 75% of what they ask)',
      },
      why: 'Even its low end pays out $11 after fees, over your $10',
      signals: [],
    });
  });

  it('skips when even the high quartile pays out less', () => {
    const call = scanCall(input({ ownHistory: history(500, 1_100) }), settings);
    expect(call.call).toBe('skip');
    expect(call.optimisticPayoutCents).toBe(990);
  });

  it("leaves a range that straddles the amount to the seller's call", () => {
    expect(scanCall(input({ ownHistory: history(800, 2_000) }), settings).call).toBe('your_call');
  });

  it('rates the confidence by the match, its size, and the identification', () => {
    const confidence = (overrides: Partial<ScanCallInput>) =>
      scanCall(input(overrides), settings).confidence;
    expect(confidence({ ownHistory: history(1_200, 2_000, 4) })).toBe('medium');
    expect(confidence({ ownHistory: history(1_200, 2_000, 9, 'brand') })).toBe('medium');
    expect(confidence({ ownHistory: history(1_200, 2_000, 9, 'category') })).toBe('low');
    expect(confidence({ ownHistory: history(1_200, 2_000), identityConfidence: 0.7 })).toBe(
      'medium',
    );
    expect(confidence({ ownHistory: history(1_200, 2_000), identityConfidence: 0.5 })).toBe('low');
  });

  it('never buys on a low-confidence read', () => {
    const call = scanCall(input({ ownHistory: history(1_200, 2_000, 9, 'category') }), settings);
    expect(call).toMatchObject({ call: 'your_call', confidence: 'low' });
  });

  it('never buys a flagged item', () => {
    for (const flag of ['visibleDamage', 'lotOrBundle', 'counterfeitProne'] as const) {
      const flags = { ...NO_FLAGS, [flag]: true };
      expect(scanCall(input({ ownHistory: history(1_200, 2_000), flags }), settings).call).toBe(
        'your_call',
      );
    }
  });

  it('falls back to the AI estimate, labeled and low confidence, when own sales are thin', () => {
    const aiEstimate = { lowCents: 1_500, midCents: 2_000, highCents: 3_000 };
    const call = scanCall(input({ ownHistory: history(100, 200, 2), aiEstimate }), settings);
    expect(call).toEqual({
      call: 'your_call',
      confidence: 'low',
      basis: 'ai_estimate',
      range: { lowCents: 1_500, highCents: 3_000 },
      conservativePayoutCents: 1_350,
      optimisticPayoutCents: 2_700,
      basedOn: AI_ESTIMATE_LABEL,
      aiEstimate,
      prices: {
        listAtCents: 3_000,
        realisticCents: 2_000,
        fastCents: 1_500,
        basedOn:
          'Likely sale is the middle of the AI estimate, fast sale its low end; list at leaves room for offers (items usually go for about 75% of what they ask)',
      },
      why: 'Pays out $14-$27 after fees, but on little to go on',
      signals: [],
    });
    const low = { lowCents: 300, midCents: 500, highCents: 800 };
    expect(scanCall(input({ aiEstimate: low }), settings).call).toBe('skip');
  });

  it('is your call, with nothing to go on, without any range', () => {
    expect(scanCall(input({}), settings)).toEqual({
      call: 'your_call',
      confidence: 'low',
      basis: 'none',
      basedOn: 'Not enough to go on',
      why: 'Not enough to price it: no sales like it, web prices, or AI estimate',
      signals: [],
    });
  });

  it('says "sold" in its basis only for real sold data', () => {
    const ai = scanCall(input({ aiEstimate: { lowCents: 1, midCents: 2, highCents: 3 } }));
    expect(ai.basedOn).toBe(AI_ESTIMATE_LABEL);
    for (const count of [1, 3, 5]) {
      const own = scanCall(input({ ownHistory: history(1_200, 2_000, count) }), {
        ...settings,
        minComparisons: 1,
      });
      expect(claimsSoldData(own.basedOn)).toBe(false);
    }
  });

  it('pays out nothing below zero when the fees exceed the price', () => {
    const call = scanCall(input({ ownHistory: history(10, 20), fees: () => 45 }), settings);
    expect(call).toMatchObject({
      conservativePayoutCents: 0,
      optimisticPayoutCents: 0,
      call: 'skip',
    });
  });

  it('raises own sales for tags still on, and says so as a starting estimate', () => {
    const call = scanCall(
      input({ ownHistory: history(1_200, 2_000), newWithTags: true }),
      settings,
    );
    expect(call.range).toEqual({ lowCents: 1_380, highCents: 2_300 });
    expect(call.signals).toEqual([
      {
        kind: 'new_with_tags',
        label: 'New with tags',
        basedOn: 'Your sales like it, plus 15% for the tags still on (a starting estimate)',
      },
    ]);
    // The AI already sees the tags: its estimate gets no bump.
    const ai = scanCall(
      input({
        aiEstimate: { lowCents: 1_000, midCents: 1_500, highCents: 2_000 },
        newWithTags: true,
      }),
      settings,
    );
    expect(ai.range).toEqual({ lowCents: 1_000, highCents: 2_000 });
    expect(ai.signals).toEqual([]);
  });

  it("holds the AI estimate to the tag's retail price, and sets own sales against it", () => {
    const aiEstimate = { lowCents: 2_000, midCents: 4_000, highCents: 6_000 };
    const ai = scanCall(
      input({ aiEstimate, retail: { lowCents: 4_500, highCents: 4_500, from: 'tag' } }),
      settings,
    );
    expect(ai.range).toEqual({ lowCents: 2_000, highCents: 4_500 });
    expect(ai.signals).toEqual([
      {
        kind: 'retail',
        label: 'Retail $45 on the tag',
        basedOn: `${AI_ESTIMATE_LABEL}, held to the retail price`,
      },
    ]);
    const own = scanCall(
      input({
        ownHistory: history(1_200, 2_000),
        retail: {
          lowCents: 5_900,
          highCents: 8_000,
          from: 'web',
          site: 'levi.com',
          models: ['501', '505'],
        },
      }),
      settings,
    );
    expect(own.range).toEqual({ lowCents: 1_200, highCents: 2_000 });
    expect(own.signals).toEqual([
      {
        kind: 'retail',
        label: 'Retail $59-$80 across 2 models',
        basedOn: 'Web info - not sold listings: levi.com; the range is 15%-25% of $80',
      },
    ]);
  });

  it('names a trend and a style only as what they rest on; slowing sales cap the confidence', () => {
    const up = {
      source: 'own_history' as const,
      direction: 'up' as const,
      recentSales: 4,
      earlierSales: 2,
      label: 'Trending up',
      basedOn: 'Your 4 sales like it in the last 90 days, 2 sales in the 9 months before',
    };
    const call = scanCall(
      input({ ownHistory: history(1_200, 2_000), trend: up, style: 'Y2K' }),
      settings,
    );
    expect(call.confidence).toBe('high');
    expect(call.signals.map((signal) => [signal.kind, signal.label])).toEqual([
      ['trend', 'Trending up'],
      ['style', 'Y2K'],
    ]);
    expect(call.signals[1]?.basedOn).toBe("The AI's read of the style, not sales data");
    const slowing = scanCall(
      input({
        ownHistory: history(1_200, 2_000),
        trend: { ...up, direction: 'down', label: 'Slowing' },
      }),
      settings,
    );
    expect(slowing.confidence).toBe('medium');
    expect(slowing.call).toBe('buy');
    // A steady trend has no label and says nothing.
    const steady = scanCall(
      input({
        ownHistory: history(1_200, 2_000),
        trend: {
          source: up.source,
          recentSales: 2,
          earlierSales: 2,
          basedOn: up.basedOn,
          direction: 'steady',
        },
      }),
      settings,
    );
    expect(steady.signals).toEqual([]);
  });

  it('rests on web info before the AI estimate, at most medium, and never above sales of its own', () => {
    const web = {
      lowCents: 3_000,
      highCents: 5_000,
      sites: ['poshmark.com', 'ebay.com'],
      reputation: 'strong' as const,
    };
    const aiEstimate = { lowCents: 6_000, midCents: 8_000, highCents: 9_000 };
    const call = scanCall(input({ web, aiEstimate }), settings);
    expect(call).toMatchObject({
      basis: 'web_info',
      confidence: 'medium',
      call: 'buy',
      range: { lowCents: 3_000, highCents: 5_000 },
      basedOn: 'Web info - not sold listings: asks on poshmark.com, ebay.com',
    });
    expect(call.signals).toEqual([
      {
        kind: 'web_resale',
        label: 'Resells well',
        basedOn: 'Web info - not sold listings: poshmark.com, ebay.com',
      },
    ]);
    // One site, or an unsure read: low confidence, so never a Buy.
    expect(scanCall(input({ web: { ...web, sites: ['ebay.com'] } }), settings).confidence).toBe(
      'low',
    );
    expect(scanCall(input({ web, identityConfidence: 0.7 }), settings).call).toBe('your_call');
    // Web info with no site behind it is nothing to go on.
    expect(scanCall(input({ web: { ...web, sites: [] } }), settings).basis).toBe('none');
    // The household's own sales come first.
    expect(scanCall(input({ web, ownHistory: history(1_200, 2_000) }), settings).basis).toBe(
      'own_history',
    );
  });
});

describe("scanCall calibrated to the seller's sales", () => {
  // The seller's items go for 80% of what they ask: the AI estimate counts 80%, the web's
  // asking prices 64% (80% of 80%).
  const calibration = { saleToAsking: 0.8, sales: 12 };
  const web = {
    lowCents: 2_500,
    highCents: 5_000,
    sites: ['poshmark.com', 'ebay.com'],
    reputation: 'unknown' as const,
  };

  it('scales the AI estimate once, shows it scaled, and says why', () => {
    const aiEstimate = { lowCents: 2_000, midCents: 3_000, highCents: 4_000 };
    const call = scanCall(input({ aiEstimate, calibration, namedBrand: true }), settings);
    expect(call).toMatchObject({
      basis: 'ai_estimate',
      range: { lowCents: 1_600, highCents: 3_200 },
      aiEstimate: { lowCents: 1_600, midCents: 2_400, highCents: 3_200 },
      basedOn: AI_ESTIMATE_LABEL,
    });
    expect(call.signals).toEqual([
      {
        kind: 'calibrated',
        label: 'Scaled to your sales',
        basedOn:
          'Your items went for 80% of what they asked (12 sales); the AI estimate is scaled to it',
      },
    ]);
  });

  it("scales the web's asking prices twice, saying they are asks", () => {
    const call = scanCall(input({ web, calibration }), settings);
    expect(call).toMatchObject({
      basis: 'web_info',
      range: { lowCents: 1_600, highCents: 3_200 },
      basedOn: 'Web info - not sold listings: asks on poshmark.com, ebay.com, scaled to your sales',
    });
    expect(call.signals.map((signal) => signal.basedOn)).toEqual([
      "Your items went for 80% of what they asked (12 sales); the web's asking prices are scaled to it",
    ]);
  });

  it('can turn a Buy on raw asks into Your call, and says the default with no sales', () => {
    // At $15 worth listing: the raw asks' low end pays $22.50, the scaled one $14.40.
    const fifteen = { ...settings, worthListingCents: 1_500 };
    expect(scanCall(input({ web }), fifteen).call).toBe('buy');
    expect(scanCall(input({ web, calibration }), fifteen).call).toBe('your_call');
    const call = scanCall(
      input({
        web,
        aiEstimate: { lowCents: 1_000, midCents: 1_500, highCents: 2_000 },
        calibration: { saleToAsking: 0.75, sales: 0 },
        namedBrand: true,
      }),
      settings,
    );
    expect(call.signals.map((signal) => signal.basedOn)).toEqual([
      "Items usually go for about 75% of what they ask; the AI estimate and the web's asking prices are scaled to it",
    ]);
    for (const signal of call.signals) expect(claimsSoldData(signal.basedOn)).toBe(false);
  });

  it("never moves a range from the household's own sales", () => {
    const call = scanCall(input({ ownHistory: history(1_200, 2_000), web, calibration }), settings);
    expect(call.basis).toBe('own_history');
    expect(call.range).toEqual({ lowCents: 1_200, highCents: 2_000 });
  });

  it('holds the scaled AI estimate to the retail price after scaling it', () => {
    const call = scanCall(
      input({
        aiEstimate: { lowCents: 4_000, midCents: 6_000, highCents: 8_000 },
        retail: { lowCents: 5_000, highCents: 5_000, from: 'tag' },
        calibration,
        namedBrand: true,
      }),
      settings,
    );
    expect(call.range).toEqual({ lowCents: 3_200, highCents: 5_000 });
  });

  it('leaves the AI estimate of an item it could not name as it is', () => {
    const aiEstimate = { lowCents: 2_000, midCents: 3_000, highCents: 4_000 };
    const call = scanCall(input({ aiEstimate, calibration, namedBrand: false }), settings);
    expect(call.range).toEqual({ lowCents: 2_000, highCents: 4_000 });
    expect(call.aiEstimate).toEqual(aiEstimate);
    expect(call.signals).toEqual([]);
  });
});

describe('the brand pulse', () => {
  const pulse = {
    verdict: 'in_demand' as const,
    reason: 'Fashion coverage has its 90s windbreakers trending again',
    premium: 'Vintage 90s pieces',
    sites: ['fashion-weekly.example', 'reddit.com'],
  };

  it('is a signal under its own label, on web info, with what asks more and the sites', () => {
    const call = scanCall(
      input({ brandPulse: pulse, ownHistory: history(1_200, 2_000) }),
      settings,
    );
    expect(call.signals).toEqual([
      {
        kind: 'brand_pulse',
        label: 'Brand pulse: in demand',
        basedOn:
          'Web info - not sold listings: Fashion coverage has its 90s windbreakers trending again. ' +
          'Asks more: Vintage 90s pieces. (fashion-weekly.example, reddit.com)',
      },
    ]);
    expect(claimsSoldData(call.signals[0]?.label ?? '')).toBe(false);
  });

  it('never moves the call, whatever its verdict', () => {
    for (const ownHistory of [history(400, 700), history(1_200, 2_000), history(2_500, 4_000)]) {
      const without = scanCall(input({ ownHistory }), settings);
      for (const verdict of ['in_demand', 'steady', 'slow'] as const) {
        const withPulse = scanCall(
          input({ ownHistory, brandPulse: { ...pulse, verdict } }),
          settings,
        );
        expect({ ...withPulse, signals: [] }).toEqual({ ...without, signals: [] });
      }
    }
    expect(
      scanCall(input({ brandPulse: { ...pulse, verdict: 'slow' } }), settings).signals,
    ).toEqual([expect.objectContaining({ label: 'Brand pulse: slow' })]);
  });

  it('fits the card: what asks more, then the last sites, give way to the reason', () => {
    const long = {
      ...pulse,
      reason: 'Collectors on the forums keep asking for the old logo pieces and the early runs now',
      premium: 'The 1990s made-in-USA line and the early artist runs',
      sites: ['fashion-weekly.example', 'collectors-forum.example', 'resale-report.example'],
    };
    const signal = brandPulseSignal(long);
    expect(signal.basedOn.length).toBeLessThanOrEqual(200);
    expect(signal.basedOn).toContain(long.reason);
    expect(signal.basedOn).toContain('(fashion-weekly.example');
    expect(signal.basedOn).not.toContain('Asks more');
    expect(brandPulseSignal({ ...pulse, premium: undefined }).basedOn).toBe(
      'Web info - not sold listings: Fashion coverage has its 90s windbreakers trending again. ' +
        '(fashion-weekly.example, reddit.com)',
    );
    expect(brandPulseSignal({ ...pulse, verdict: 'steady' }).label).toBe('Brand pulse: steady');
  });
});

describe('scanCall three prices', () => {
  const own = (calibration?: { saleToAsking: number; sales: number }) =>
    scanCall(
      input({
        ownHistory: history(2_000, 4_000),
        ...(calibration === undefined ? {} : { calibration }),
      }),
      settings,
    );

  it("lists at the realistic sale over the seller's own sale-to-asking ratio", () => {
    // Median $30; at 60% the list price is $50, at the 75% default $40.
    expect(own({ saleToAsking: 0.6, sales: 40 }).prices).toMatchObject({
      listAtCents: 5_000,
      realisticCents: 3_000,
      fastCents: 2_000,
    });
    expect(own({ saleToAsking: 0.6, sales: 40 }).prices?.basedOn).toContain(
      'your items went for 60% of what they asked',
    );
    expect(own().prices).toMatchObject({ listAtCents: 4_000, realisticCents: 3_000 });
    expect(own({ saleToAsking: 0.75, sales: 0 }).prices?.basedOn).toContain(
      'items usually go for about 75% of what they ask',
    );
  });

  it('never changes the call, its range, or its payouts', () => {
    expect(own({ saleToAsking: 0.5, sales: 10 })).toMatchObject({
      call: 'buy',
      range: { lowCents: 2_000, highCents: 4_000 },
      conservativePayoutCents: 1_800,
      optimisticPayoutCents: 3_600,
    });
  });

  it("takes the realistic sale from the middle of the web's scaled asks", () => {
    const call = scanCall(
      input({
        web: {
          lowCents: 4_000,
          highCents: 8_000,
          sites: ['a.example', 'b.example'],
          reputation: 'average',
        },
        calibration: { saleToAsking: 0.5, sales: 20 },
      }),
      settings,
    );
    // Asks $40-$80 scaled by 0.25: $10-$20, middle $15, listed at $30.
    expect(call.range).toEqual({ lowCents: 1_000, highCents: 2_000 });
    expect(call.prices).toMatchObject({
      listAtCents: 3_000,
      realisticCents: 1_500,
      fastCents: 1_000,
    });
    expect(call.prices?.basedOn).toContain("the middle of the web's asks, scaled to your sales");
  });

  it('raises the realistic sale with the range for tags still on', () => {
    const call = scanCall(
      input({ ownHistory: history(2_000, 4_000), newWithTags: true }),
      settings,
    );
    // Median $30 plus 15% is $34.50, a $35 realistic sale; the low end $23 a $20 fast sale.
    expect(call.prices).toMatchObject({ realisticCents: 3_500, fastCents: 2_000 });
  });

  it('keeps the realistic sale inside a range held to the retail price', () => {
    const call = scanCall(
      input({
        aiEstimate: { lowCents: 3_000, midCents: 5_000, highCents: 8_000 },
        retail: { lowCents: 4_000, highCents: 4_000, from: 'tag' },
      }),
      settings,
    );
    expect(call.range).toEqual({ lowCents: 3_000, highCents: 4_000 });
    expect(call.prices).toMatchObject({ realisticCents: 4_000, fastCents: 3_000 });
  });

  it('has no prices without a range', () => {
    expect(scanCall(input({}), settings).prices).toBeUndefined();
  });

  it('never says "sold", whatever the call rests on', () => {
    const calls = [
      own(),
      scanCall(
        input({ aiEstimate: { lowCents: 1_000, midCents: 1_500, highCents: 2_000 } }),
        settings,
      ),
      scanCall(
        input({
          markets: [
            {
              marketplace: 'eBay',
              sold: { count: 9, lowCents: 1_800, highCents: 3_000, windowDays: 14, level: 'model' },
            },
          ],
        }),
        settings,
      ),
    ];
    for (const { prices } of calls) {
      if (prices === undefined) throw new Error('expected the three prices');
      expect(claimsSoldData(prices.basedOn)).toBe(false);
      expect(claimsSoldData(pricesSignal(prices).label)).toBe(false);
    }
  });

  it('shows as a signal for a card built before them', () => {
    const prices = own({ saleToAsking: 0.6, sales: 40 }).prices;
    if (prices === undefined) throw new Error('expected the three prices');
    expect(pricesSignal(prices)).toEqual({
      kind: 'prices',
      label: 'List at $50 · Likely sale $30 · Fast sale $20',
      basedOn: prices.basedOn,
    });
    expect(pricesSignal({ ...prices, listAtCents: 120_000 }).label.length).toBeLessThanOrEqual(60);
  });
});

describe('callWhy', () => {
  const flags = { visibleDamage: false, lotOrBundle: false, counterfeitProne: false };
  const worth = { worthListingCents: 800 };
  const payouts = (
    low: number,
    high: number,
    confidence: 'high' | 'medium' | 'low' = 'medium',
  ) => ({
    conservativePayoutCents: low,
    optimisticPayoutCents: high,
    confidence,
  });

  it('says why a Grab, a Leave, and a Maybe, in one line without "sold"', () => {
    const whys = [
      callWhy('buy', payouts(1_100, 1_800), flags, worth),
      callWhy('skip', payouts(300, 640), flags, worth),
      callWhy('your_call', payouts(500, 1_200), flags, worth),
      callWhy('your_call', payouts(900, 1_500, 'low'), flags, worth),
      callWhy('your_call', payouts(900, 1_500), { ...flags, visibleDamage: true }, worth),
      callWhy('your_call', payouts(900, 1_500), { ...flags, counterfeitProne: true }, worth),
      callWhy('your_call', payouts(900, 1_500), { ...flags, lotOrBundle: true }, worth),
    ];
    expect(whys).toEqual([
      'Even its low end pays out $11 after fees, over your $8',
      'Pays out $6 at most after fees, under your $8',
      'Pays out $5-$12 after fees: it may or may not clear your $8',
      'Pays out $9-$15 after fees, but on little to go on',
      'Pays out $9-$15 after fees, but it shows damage',
      "Pays out $9-$15 after fees, but often faked: check it's real",
      "Pays out $9-$15 after fees, but it's a lot or bundle",
    ]);
    for (const why of whys) {
      expect(claimsSoldData(why)).toBe(false);
      expect(why.length).toBeLessThanOrEqual(140);
    }
  });

  it('says one amount when both ends pay out the same, and never a negative payout', () => {
    expect(callWhy('your_call', payouts(-50, -50), flags, worth)).toBe(
      'Pays out $0 after fees: it may or may not clear your $8',
    );
  });
});

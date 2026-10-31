import { AI_ESTIMATE_LABEL, claimsSoldData } from '@listora/pricing';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SCAN_CALL_SETTINGS,
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
      basedOn: 'Web info - not sold listings: poshmark.com, ebay.com',
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

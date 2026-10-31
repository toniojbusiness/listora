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
      conservativePayoutCents: 1_080,
      optimisticPayoutCents: 1_800,
      basedOn: 'Your 5 sales like it',
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
      conservativePayoutCents: 1_350,
      optimisticPayoutCents: 2_700,
      basedOn: AI_ESTIMATE_LABEL,
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
});

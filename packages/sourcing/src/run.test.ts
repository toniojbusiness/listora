import { claimsSoldData } from '@listora/pricing';
import { describe, expect, it } from 'vitest';

import { RUN_ESTIMATE_AI_LABEL, RUN_ESTIMATE_LABEL, runEstimate, runProfit } from './run.ts';

const own = {
  basis: 'own_history' as const,
  lowCents: 2000,
  highCents: 3000,
  conservativePayoutCents: 1700,
  optimisticPayoutCents: 2600,
};
const ai = {
  basis: 'ai_estimate' as const,
  lowCents: 1000,
  highCents: 1800,
  conservativePayoutCents: 800,
  optimisticPayoutCents: 1500,
};

describe('runEstimate', () => {
  it('adds up the kept scans’ ranges and payouts', () => {
    const estimate = runEstimate([own, own, ai]);
    expect(estimate).toEqual({
      itemCount: 3,
      resaleLowCents: 5000,
      resaleHighCents: 7800,
      payoutLowCents: 4200,
      payoutHighCents: 6700,
      byBasis: { own_history: 2, web_info: 0, ai_estimate: 1 },
      basedOn: '2 from your own sales, 1 from the AI estimate',
      label: RUN_ESTIMATE_AI_LABEL,
    });
  });

  it('leaves out a scan with nothing to go on', () => {
    const estimate = runEstimate([own, { basis: 'none' }, { basis: 'ai_estimate', lowCents: 900 }]);
    expect(estimate?.itemCount).toBe(1);
    expect(estimate?.resaleLowCents).toBe(2000);
    expect(estimate?.label).toBe(RUN_ESTIMATE_LABEL);
    expect(estimate?.basedOn).toBe('1 from your own sales');
  });

  it('has no estimate without a range', () => {
    expect(runEstimate([])).toBeUndefined();
    expect(runEstimate([{ basis: 'none' }])).toBeUndefined();
  });

  it('names its sources in the call’s trust order', () => {
    const web = { ...ai, basis: 'web_info' as const };
    expect(runEstimate([ai, web, own])?.basedOn).toBe(
      '1 from your own sales, 1 from web info, 1 from the AI estimate',
    );
  });

  it('never claims sold data, except the AI estimate’s own disclaimer', () => {
    const estimate = runEstimate([own, ai]);
    expect(claimsSoldData(estimate?.basedOn ?? 'sold')).toBe(false);
    expect(claimsSoldData(RUN_ESTIMATE_LABEL)).toBe(false);
    expect(RUN_ESTIMATE_AI_LABEL).toContain('not based on sold listings');
  });
});

describe('runProfit', () => {
  it('is the payout less what the whole haul cost, possibly a loss', () => {
    const estimate = runEstimate([own, ai]);
    if (!estimate) throw new Error('no estimate');
    expect(runProfit(estimate, 1000)).toEqual({ lowCents: 1500, highCents: 3100 });
    expect(runProfit(estimate, 4000)).toEqual({ lowCents: -1500, highCents: 100 });
  });
});

import type { ItemScan } from '@listora/api-contract';
import { describe, expect, it } from 'vitest';

import { AI_ESTIMATE_LABEL, ASKING_PRICES_LABEL, scanLabelViolations } from './labels.ts';
import { scanResearchLinks } from './research-links.ts';

const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });

/** An invented scan answer resting on the AI estimate. */
function scan(overrides: Partial<ItemScan> = {}): ItemScan {
  return {
    id: '0193a000-0000-7000-8000-000000000001',
    runId: '0193a000-0000-7000-8000-000000000002',
    createdAt: '2026-10-31T00:00:00.000Z',
    identity: { item: 'sold out tour tee', brand: 'Band Merch', confidence: 0.7 },
    aiEstimate: { label: AI_ESTIMATE_LABEL, low: usd(1200), mid: usd(1600), high: usd(2200) },
    flags: { visibleDamage: false, lotOrBundle: false, counterfeitProne: false },
    ownSales: [],
    call: {
      call: 'your_call',
      label: 'Your call',
      confidence: 'low',
      basis: 'ai_estimate',
      basedOn: AI_ESTIMATE_LABEL,
      worthListing: usd(800),
      signals: [
        {
          kind: 'retail',
          label: 'Retail about $40',
          basedOn: 'Web info - not sold listings: bandmerch.example',
        },
      ],
    },
    research: {
      status: 'found',
      label: 'Web info - not sold listings',
      reputation: 'average',
      cached: false,
    },
    searchWords: 'sold out tour tee',
    researchLinks: scanResearchLinks('band tee'),
    decision: 'undecided',
    ...overrides,
  };
}

describe('scanLabelViolations', () => {
  it('passes an honest answer, whatever the item is called', () => {
    expect(scanLabelViolations(scan())).toEqual([]);
  });

  it('refuses an AI estimate that is not labeled one, or a call that claims sales', () => {
    const base = scan();
    const estimate = { label: 'Estimated', low: usd(1), mid: usd(2), high: usd(3) };
    expect(
      scanLabelViolations(
        scan({
          aiEstimate: estimate,
          call: { ...base.call, basedOn: 'Similar items sold for $20' },
        }),
      ),
    ).toEqual([
      'aiEstimate.label is "Estimated"',
      'call.basedOn is "Similar items sold for $20" for an AI estimate',
      'call.basedOn mentions sold data: "Similar items sold for $20"',
    ]);
    expect(
      scanLabelViolations(
        scan({ researchLinks: [{ label: 'Sold comps', url: 'https://x.test/' }] }),
      ),
    ).toEqual(['researchLinks[0] is labeled "Sold comps"']);
    expect(
      scanLabelViolations(
        scan({
          research: {
            status: 'found',
            label: 'Web',
            reputation: 'unknown',
            summary: 'It sold for $9.',
            cached: false,
          },
        }),
      ),
    ).toEqual([
      'research.label is "Web"',
      'research.summary mentions sold data: "It sold for $9."',
    ]);
  });

  it("holds a comparison's asking prices to their label, and its row to no sold claim", () => {
    const asking = { count: 6, low: usd(2500), median: usd(3000), high: usd(4000) };
    const row = {
      marketplace: 'depop' as const,
      status: 'read' as const,
      label: 'Depop: asking $25-$40, 6 like it for sale',
    };
    expect(
      scanLabelViolations(
        scan({ comparisons: [{ ...row, asking: { ...asking, label: ASKING_PRICES_LABEL } }] }),
      ),
    ).toEqual([]);
    expect(
      scanLabelViolations(
        scan({
          comparisons: [
            { ...row, label: 'Depop: 6 sold', asking: { ...asking, label: 'Depop prices' } },
          ],
        }),
      ),
    ).toEqual([
      'comparisons[0].asking.label is "Depop prices"',
      'comparisons[0].label mentions sold data: "Depop: 6 sold"',
    ]);
  });
});

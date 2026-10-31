import { describe, expect, it } from 'vitest';

import {
  MAX_RESEARCH_SEARCHES,
  researchScanItem,
  SCAN_RESEARCH_OUTPUT_NAME,
  SCAN_RESEARCH_PURPOSE,
  ScanResearchFailedError,
  verifiedResearch,
  type ScanResearchAnswer,
} from './scan-research.ts';
import { ACCOUNT, client } from './test-support.ts';

// Invented items and pages; no real shop's data.
const HASH = 'c'.repeat(64);
const RETAIL_PAGE = {
  url: 'https://www.patagonia.com/product/synchilla-fleece/',
  title: 'Synchilla',
};
const RESALE_PAGES = [
  { url: 'https://poshmark.com/brand/Patagonia-Synchilla', title: 'Poshmark' },
  { url: 'https://www.ebay.com/b/Patagonia-Synchilla/bn_1', title: 'eBay' },
];

function answer(overrides: Partial<ScanResearchAnswer> = {}): ScanResearchAnswer {
  return {
    retail: {
      lowCents: 13_900,
      highCents: 13_900,
      sourceUrls: [RETAIL_PAGE.url],
      models: ['Synchilla Snap-T'],
    },
    resale: { lowCents: 4_000, highCents: 7_000, sourceUrls: RESALE_PAGES.map((page) => page.url) },
    reputation: 'strong',
    summary:
      "Patagonia's site lists the Synchilla at $139; used ones ask $40-$70 on Poshmark and eBay.",
    ...overrides,
  };
}

const input = {
  accountId: ACCOUNT,
  userId: null,
  keyHash: HASH,
  brand: 'Patagonia',
  item: 'Synchilla fleece',
};

describe('researchScanItem', () => {
  it('searches the web, keeps every number with its page, and meters the searches', async () => {
    const { ai, usageStore } = client({
      hash: HASH,
      fixture: {
        outputs: { [SCAN_RESEARCH_OUTPUT_NAME]: answer() },
        webSources: [RETAIL_PAGE, ...RESALE_PAGES],
        usage: { webSearches: 2 },
      },
    });
    const outcome = await researchScanItem(ai, input);
    expect(outcome.research).toEqual({
      retail: {
        lowCents: 13_900,
        highCents: 13_900,
        sources: [{ url: RETAIL_PAGE.url, site: 'patagonia.com' }],
        models: ['Synchilla Snap-T'],
      },
      resale: {
        lowCents: 4_000,
        highCents: 7_000,
        sources: [
          { url: RESALE_PAGES[0]?.url, site: 'poshmark.com' },
          { url: RESALE_PAGES[1]?.url, site: 'ebay.com' },
        ],
      },
      reputation: 'strong',
      summary: answer().summary,
    });
    expect(outcome.searches).toBe(2);
    // Two searches at $0.01 each, plus the tokens.
    expect(outcome.costMicros).toBeGreaterThan(20_000);
    expect(usageStore.events).toMatchObject([
      { purpose: SCAN_RESEARCH_PURPOSE, outcome: 'succeeded', images: 0 },
    ]);
    expect(MAX_RESEARCH_SEARCHES).toBe(2);
  });

  it('fails with what it cost when no answer is usable', async () => {
    const { ai } = client({
      hash: HASH,
      fixture: { outputs: { [SCAN_RESEARCH_OUTPUT_NAME]: { nope: 1 } } },
    });
    const error = await researchScanItem(ai, input).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ScanResearchFailedError);
    expect((error as ScanResearchFailedError).attempts).toBe(2);
  });
});

describe('verifiedResearch', () => {
  it('drops any price whose page the search never returned, and a summary that claims sales', () => {
    const research = verifiedResearch(
      answer({ summary: 'Similar fleeces sold for $50 on eBay.' }),
      RESALE_PAGES.slice(1),
    );
    expect(research.retail).toBeNull();
    expect(research.resale?.sources.map((source) => source.site)).toEqual(['ebay.com']);
    expect(research.summary).toBeNull();
  });

  it('has nothing, and no reputation, when no page backs anything', () => {
    expect(verifiedResearch(answer(), [])).toEqual({
      retail: null,
      resale: null,
      reputation: 'unknown',
      summary: null,
    });
    // A made-up address is no source, even on a returned site.
    const madeUp = verifiedResearch(
      answer({
        retail: {
          lowCents: 9_900,
          highCents: 9_900,
          sourceUrls: ['https://www.patagonia.com/made-up'],
          models: [],
        },
      }),
      [RETAIL_PAGE],
    );
    expect(madeUp.retail).toBeNull();
  });

  it('takes a resale range only from the resale marketplaces, never a price-estimator site', () => {
    const estimator = { url: 'https://resale-value-guess.example/patagonia', title: 'Guess' };
    const research = verifiedResearch(
      answer({ resale: { lowCents: 4_000, highCents: 7_000, sourceUrls: [estimator.url] } }),
      [RETAIL_PAGE, estimator],
    );
    expect(research.resale).toBeNull();
    expect(research.retail).not.toBeNull();
  });
});

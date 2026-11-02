import { describe, expect, it } from 'vitest';

import {
  BRAND_PULSE_OUTPUT_NAME,
  BRAND_PULSE_PURPOSE,
  BrandPulseFailedError,
  MAX_PULSE_PREMIUM_LENGTH,
  MAX_PULSE_REASON_LENGTH,
  MAX_PULSE_SEARCHES,
  researchBrandPulse,
  verifiedPulse,
  type BrandPulseAnswer,
} from './brand-pulse.ts';
import { ACCOUNT, client } from './test-support.ts';

// An invented brand and invented pages; no real shop's data.
const HASH = 'd'.repeat(64);
const PAGES = [
  { url: 'https://www.fashion-weekly.example/acme-revival/', title: 'The Acme revival' },
  { url: 'https://www.reddit.com/r/thriftstorehauls/comments/abc/acme/', title: 'Acme finds' },
  { url: 'https://resale-report.example/2026', title: 'Resale report 2026' },
];

function answer(overrides: Partial<BrandPulseAnswer> = {}): BrandPulseAnswer {
  return {
    verdict: 'in_demand',
    reason: 'Fashion coverage has its 90s windbreakers trending again.',
    premium: 'Vintage 90s pieces',
    sourceUrls: PAGES.slice(0, 2).map((page) => page.url),
    ...overrides,
  };
}

const input = { accountId: ACCOUNT, userId: null, keyHash: HASH, brand: 'Acme Outfitters' };

describe('researchBrandPulse', () => {
  it('asks the wider web once, keeps the pages it rests on, and meters the search', async () => {
    const { ai, usageStore } = client({
      hash: HASH,
      fixture: {
        outputs: { [BRAND_PULSE_OUTPUT_NAME]: answer() },
        webSources: PAGES,
        usage: { webSearches: 1 },
      },
    });
    const outcome = await researchBrandPulse(ai, input);
    expect(outcome.pulse).toEqual({
      verdict: 'in_demand',
      reason: 'Fashion coverage has its 90s windbreakers trending again.',
      premium: 'Vintage 90s pieces',
      sources: [
        { url: PAGES[0]?.url, site: 'fashion-weekly.example' },
        { url: PAGES[1]?.url, site: 'reddit.com' },
      ],
    });
    expect(outcome.searches).toBe(1);
    // One search at $0.01, plus the tokens.
    expect(outcome.costMicros).toBeGreaterThan(10_000);
    expect(usageStore.events).toMatchObject([
      { purpose: BRAND_PULSE_PURPOSE, outcome: 'succeeded', images: 0 },
    ]);
    expect(MAX_PULSE_SEARCHES).toBe(1);
  });

  it('fails with what it cost when no answer is usable', async () => {
    const { ai } = client({
      hash: HASH,
      fixture: { outputs: { [BRAND_PULSE_OUTPUT_NAME]: { verdict: 'hot' } } },
    });
    const error = await researchBrandPulse(ai, input).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(BrandPulseFailedError);
    expect((error as BrandPulseFailedError).attempts).toBe(2);
    expect((error as BrandPulseFailedError).costMicros).toBeGreaterThan(0);
  });
});

describe('verifiedPulse', () => {
  it('says nothing on pages the search never returned', () => {
    expect(verifiedPulse(answer(), PAGES.slice(2))).toEqual({
      verdict: 'unknown',
      reason: '',
      premium: null,
      sources: [],
    });
    // A made-up address on a returned site is no source either.
    expect(
      verifiedPulse(answer({ sourceUrls: ['https://www.reddit.com/r/made-up/'] }), PAGES).verdict,
    ).toBe('unknown');
  });

  it('keeps a page however the address is written, once a site', () => {
    const pulse = verifiedPulse(
      answer({
        sourceUrls: [
          'https://fashion-weekly.example/acme-revival#top',
          'https://www.fashion-weekly.example/acme-revival/',
        ],
      }),
      PAGES,
    );
    expect(pulse.sources.map((source) => source.site)).toEqual(['fashion-weekly.example']);
  });

  it('never calls web info sales: a reason that does is no pulse, a premium that does is dropped', () => {
    expect(
      verifiedPulse(answer({ reason: 'Jackets sold fast on eBay this year.' }), PAGES).verdict,
    ).toBe('unknown');
    const pulse = verifiedPulse(answer({ premium: 'Comps for the 90s line are higher' }), PAGES);
    expect(pulse.verdict).toBe('in_demand');
    expect(pulse.premium).toBeNull();
    // Prices stay with the card's prices.
    expect(
      verifiedPulse(answer({ premium: 'New with tags ($15 vs $11)' }), PAGES).premium,
    ).toBeNull();
  });

  it('is unknown without a reason, and with the verdict unknown whatever else it says', () => {
    expect(verifiedPulse(answer({ reason: '  ' }), PAGES).verdict).toBe('unknown');
    expect(verifiedPulse(answer({ verdict: 'unknown' }), PAGES)).toMatchObject({
      verdict: 'unknown',
      sources: [],
    });
  });

  it('cuts a long reason and premium to the card at a word', () => {
    const pulse = verifiedPulse(
      answer({
        reason: `${'Collectors on the forums keep asking for the old logo pieces '.repeat(3)}now.`,
        premium: 'The 1990s made-in-USA line and the early collaboration runs with artists',
      }),
      PAGES,
    );
    expect(pulse.reason.length).toBeLessThanOrEqual(MAX_PULSE_REASON_LENGTH);
    expect(pulse.reason.endsWith('…')).toBe(true);
    expect(pulse.premium?.length).toBeLessThanOrEqual(MAX_PULSE_PREMIUM_LENGTH);
    expect(pulse.premium?.endsWith('…')).toBe(true);
  });

  it('keeps slow and steady as they are', () => {
    expect(verifiedPulse(answer({ verdict: 'slow', premium: '' }), PAGES)).toMatchObject({
      verdict: 'slow',
      premium: null,
    });
    expect(verifiedPulse(answer({ verdict: 'steady' }), PAGES).verdict).toBe('steady');
    // "None" is no premium.
    for (const none of ['None', 'none.', 'N/A', ' - ']) {
      expect(verifiedPulse(answer({ premium: none }), PAGES).premium).toBeNull();
    }
  });
});

import { describe, expect, it } from 'vitest';

import { claimsSoldData } from './labels.ts';
import {
  DEPOP_SEARCH_LABEL,
  EBAY_SOLD_SEARCH_LABEL,
  MAX_RESEARCH_QUERY_LENGTH,
  MERCARI_SEARCH_LABEL,
  POSHMARK_SEARCH_LABEL,
  RESEARCH_LINK_LABELS,
  researchLinks,
  researchQuery,
  scanResearchLinks,
  TERAPEAK_LABEL,
} from './research-links.ts';

describe('researchQuery', () => {
  it('uses the title, with whitespace collapsed', () => {
    expect(researchQuery({ title: '  Vintage   Levi’s 501  ', brand: 'Levi’s' })).toBe(
      'Vintage Levi’s 501',
    );
  });

  it('falls back to brand, product name, style number, and category', () => {
    expect(
      researchQuery({ brand: 'Patagonia', productName: 'Retro-X', styleNumber: '23056' }),
    ).toBe('Patagonia Retro-X 23056');
    expect(researchQuery({ title: '   ', category: 'jackets' })).toBe('jackets');
  });

  it('is undefined for an item without any words yet', () => {
    expect(researchQuery({})).toBeUndefined();
    expect(researchQuery({ title: ' ', brand: '' })).toBeUndefined();
  });

  it('cuts a long query at a word boundary', () => {
    const query = researchQuery({ title: 'word '.repeat(40) });
    expect(query?.length).toBeLessThanOrEqual(MAX_RESEARCH_QUERY_LENGTH);
    expect(query?.endsWith('word')).toBe(true);
    expect(researchQuery({ title: 'x'.repeat(150) })).toBe('x'.repeat(MAX_RESEARCH_QUERY_LENGTH));
  });
});

describe('researchLinks', () => {
  it('builds the eBay sold-listings search and Terapeak, with the query encoded', () => {
    const links = researchLinks('Levi’s 501 & co');
    expect(links.map((link) => link.label)).toEqual([EBAY_SOLD_SEARCH_LABEL, TERAPEAK_LABEL]);

    const sold = new URL(links[0]?.url ?? '');
    expect(sold.origin + sold.pathname).toBe('https://www.ebay.com/sch/i.html');
    expect(Object.fromEntries(sold.searchParams)).toEqual({
      _nkw: 'Levi’s 501 & co',
      LH_Sold: '1',
      LH_Complete: '1',
    });

    const terapeak = new URL(links[1]?.url ?? '');
    expect(terapeak.origin + terapeak.pathname).toBe('https://www.ebay.com/sh/research');
    expect(Object.fromEntries(terapeak.searchParams)).toEqual({
      marketplace: 'EBAY-US',
      keywords: 'Levi’s 501 & co',
      tabName: 'SOLD',
    });
  });

  it('has no links without a query', () => {
    expect(researchLinks(undefined)).toEqual([]);
  });
});

describe('scanResearchLinks', () => {
  it("opens Depop first, then the others, only eBay's claiming sold listings", () => {
    const links = scanResearchLinks('  Lululemon   Align leggings ');
    expect(links.map((link) => link.label)).toEqual([
      DEPOP_SEARCH_LABEL,
      EBAY_SOLD_SEARCH_LABEL,
      POSHMARK_SEARCH_LABEL,
      MERCARI_SEARCH_LABEL,
    ]);
    expect(links.map((link) => new URL(link.url).origin)).toEqual([
      'https://www.depop.com',
      'https://www.ebay.com',
      'https://poshmark.com',
      'https://www.mercari.com',
    ]);
    expect(new URL(links[0]?.url ?? '').searchParams.get('q')).toBe('Lululemon Align leggings');
    expect(new URL(links[3]?.url ?? '').searchParams.get('keyword')).toBe(
      'Lululemon Align leggings',
    );
    expect(links.every((link) => RESEARCH_LINK_LABELS.has(link.label))).toBe(true);
    expect(links.filter((link) => claimsSoldData(link.label))).toEqual([links[1]]);
  });

  it('has none without search words', () => {
    expect(scanResearchLinks(undefined)).toEqual([]);
    expect(scanResearchLinks('   ')).toEqual([]);
  });
});

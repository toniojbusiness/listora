import { describe, expect, it } from 'vitest';

import { ebaySearchUrl, groupResults, resultCount, soldDay, titleSizes } from './search-page.ts';

describe("eBay's search results", () => {
  it('opens the URLs its own sold filter and sort make', () => {
    const site = { origin: 'https://www.ebay.com' };
    expect(ebaySearchUrl(site, ' levis 501 jeans ', 'sold')).toBe(
      'https://www.ebay.com/sch/i.html?_nkw=levis+501+jeans&LH_Sold=1&LH_Complete=1&_sop=13',
    );
    expect(ebaySearchUrl(site, 'levis 501 jeans', 'for_sale')).toBe(
      'https://www.ebay.com/sch/i.html?_nkw=levis+501+jeans',
    );
  });

  it("reads the search's count, exact or at least", () => {
    expect(resultCount('1,204 results for levis 501 jeans')).toBe(1204);
    expect(resultCount('10,000+ results for levis')).toBe(10000);
    expect(resultCount('1 result for levis 501 28x36')).toBe(1);
    expect(resultCount('0 results found')).toBe(0);
    expect(resultCount('Shop by category')).toBeNull();
  });

  it('reads the day a result sold', () => {
    expect(soldDay(['Sold  Oct 28, 2026'])).toEqual(new Date('2026-10-28T12:00:00Z'));
    expect(soldDay(['Brand new', 'Sold Jan 3, 2027'])).toEqual(new Date('2027-01-03T12:00:00Z'));
    expect(soldDay(['Sold  Feb 30, 2026'])).toBeNull();
    expect(soldDay(['New listing'])).toBeNull();
  });

  it('reads the sizes a title names', () => {
    expect(titleSizes("Levi's 501 Jeans 32x30")).toEqual(['32x30', '32']);
    expect(titleSizes('Levis 501 W32 L30 Medium Wash')).toEqual(['32x30', '32', 'Medium']);
    expect(titleSizes('Nike Hoodie Size L Gray')).toEqual(['L']);
    expect(titleSizes('Patagonia fleece sz. XL')).toEqual(['XL']);
    // A lone letter names no size without "size" before it: "L.L.Bean" and "M&M" are not sizes.
    expect(titleSizes('L.L.Bean flannel shirt M&M print')).toEqual([]);
  });

  it("groups the page's parts into results, up to the fewer-words line", () => {
    const parts: [string, string][] = [
      ['s-card s-card--horizontal', "Levi's 501 · $28.00 · Sold Oct 29, 2026"],
      ['s-card__caption', 'Sold Oct 29, 2026'],
      ['s-card__title', "Levi's 501"],
      ['s-card__price', '$28.00'],
      ['s-card__price', '$40.00'],
      ['srp-river-answer srp-river-answer--RELATED', 'Related searches'],
      ['s-item s-item__pl-on-bottom', 'Levis 501'],
      ['s-item__title', 'Levis 501'],
      ['s-item__price', '$30.00'],
      ['srp-river-answer srp-river-answer--REWRITE_START', 'Results matching fewer words'],
      ['s-card', "Levi's 505"],
      ['s-card__title', "Levi's 505"],
    ];
    expect(
      groupResults(
        parts.map(([names]) => names),
        parts.map(([, text]) => text),
      ),
    ).toEqual([
      {
        text: "Levi's 501 · $28.00 · Sold Oct 29, 2026",
        title: "Levi's 501",
        price: '$28.00',
        captions: ['Sold Oct 29, 2026'],
      },
      { text: 'Levis 501', title: 'Levis 501', price: '$30.00', captions: [] },
    ]);
  });
});

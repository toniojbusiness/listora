import { describe, expect, it } from 'vitest';

import {
  closestPhotos,
  matchListing,
  titleSimilarity,
  titleWords,
  type MatchCandidate,
} from './match.ts';

const PHOTO = 'f0f0f0f0f0f0f0f0';
/** Two bits from PHOTO: the same photo, re-encoded. */
const SAME_PHOTO = 'f0f0f0f0f0f0f0f3';
/** Ten bits from PHOTO: another shot of the same item. */
const ALIKE_PHOTO = 'f0f0f0f0f0f0ffcf';
const OTHER_PHOTO = '0f0f0f0f0f0f0f0f';

function candidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    itemId: 'item-1',
    sku: 'AJ-000001',
    title: "Levi's 501 jeans",
    brand: "Levi's",
    listingSkus: [],
    photoHashes: [PHOTO],
    ...overrides,
  };
}

describe('matchListing', () => {
  it("finds the item its SKU line names, as the item's SKU or another listing's line", () => {
    const items = [
      candidate(),
      candidate({ itemId: 'item-2', sku: 'AJ-000002', listingSkus: ['X-9'] }),
    ];
    const listing = { sku: 'aj-000002', title: 'Anything', brand: null, photoHashes: [] };
    expect(matchListing(listing, items)).toEqual({ type: 'match', itemId: 'item-2', match: 'sku' });
    expect(matchListing({ ...listing, sku: 'X-9' }, items)).toEqual({
      type: 'match',
      itemId: 'item-2',
      match: 'sku',
    });
  });

  it('merges only when the photo and the title both say it is the same item', () => {
    const items = [
      candidate(),
      candidate({ itemId: 'item-2', title: 'Wool scarf', photoHashes: [OTHER_PHOTO] }),
    ];
    expect(
      matchListing(
        { sku: null, title: "Levi's 501 jeans 32x30", brand: "Levi's", photoHashes: [SAME_PHOTO] },
        items,
      ),
    ).toEqual({ type: 'match', itemId: 'item-1', match: 'title_photos' });
    // A nearly identical title and photos that look alike.
    expect(
      matchListing(
        { sku: null, title: "Levi's 501 jeans", brand: null, photoHashes: [ALIKE_PHOTO] },
        items,
      ),
    ).toEqual({ type: 'match', itemId: 'item-1', match: 'title_photos' });
  });

  it('asks when only the photo or only the title points to an item', () => {
    const items = [candidate()];
    expect(
      matchListing(
        { sku: null, title: 'Black denim jacket', brand: null, photoHashes: [SAME_PHOTO] },
        items,
      ),
    ).toEqual({ type: 'unsure', candidates: [{ itemId: 'item-1', reason: 'photo' }] });
    expect(
      matchListing(
        { sku: null, title: "Levi's 501 jeans", brand: null, photoHashes: [OTHER_PHOTO] },
        items,
      ),
    ).toEqual({ type: 'unsure', candidates: [{ itemId: 'item-1', reason: 'title' }] });
  });

  it('asks, best first, when two items are both the same as the listing', () => {
    const items = [
      candidate({ itemId: 'item-a', photoHashes: [ALIKE_PHOTO] }),
      candidate({ itemId: 'item-b', photoHashes: [SAME_PHOTO] }),
    ];
    const result = matchListing(
      { sku: null, title: "Levi's 501 jeans", brand: null, photoHashes: [PHOTO] },
      items,
    );
    expect(result).toEqual({
      type: 'unsure',
      candidates: [
        { itemId: 'item-b', reason: 'photo_and_title' },
        { itemId: 'item-a', reason: 'photo_and_title' },
      ],
    });
  });

  it('never merges items of different brands, and asks instead', () => {
    expect(
      matchListing(
        { sku: null, title: "Levi's 501 jeans", brand: 'Wrangler', photoHashes: [SAME_PHOTO] },
        [candidate()],
      ),
    ).toEqual({ type: 'unsure', candidates: [{ itemId: 'item-1', reason: 'photo' }] });
  });

  it('is a new item when nothing is alike', () => {
    expect(
      matchListing({ sku: null, title: 'Wool scarf', brand: null, photoHashes: [OTHER_PHOTO] }, [
        candidate(),
      ]),
    ).toEqual({ type: 'new' });
    expect(
      matchListing({ sku: 'AJ-999', title: null, brand: null, photoHashes: [] }, [candidate()]),
    ).toEqual({
      type: 'new',
    });
  });
});

describe('titles and photos', () => {
  it("compares titles' telling words, ignoring case, punctuation, and filler", () => {
    expect([...titleWords("NWT Women's Levi’s 501 Jeans, size 8!")]).toEqual([
      'levis',
      '501',
      'jeans',
    ]);
    expect(
      titleSimilarity(titleWords("Levi's 501 jeans"), titleWords('levis 501 jeans dark wash')),
    ).toBe(1);
    expect(titleSimilarity(titleWords('Wool scarf'), titleWords("Levi's 501 jeans"))).toBe(0);
    expect(titleSimilarity(titleWords(null), titleWords('Wool scarf'))).toBe(0);
  });

  it('takes the closest pair of photos', () => {
    expect(closestPhotos([OTHER_PHOTO, SAME_PHOTO], [PHOTO])).toBe(2);
    expect(closestPhotos([], [PHOTO])).toBeNull();
  });
});

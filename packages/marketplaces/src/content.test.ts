import { describe, expect, it } from 'vitest';

import {
  desiredStateForContent,
  InvalidListingContentError,
  isContentKind,
  listingContentToJson,
  parseListingContent,
  photosInOrder,
} from './content.ts';
import { sampleListingContent } from './testing.ts';

describe('listing content', () => {
  it('round-trips through JSON in one canonical key order', () => {
    const content = sampleListingContent();
    const json = listingContentToJson(content);
    expect(parseListingContent(json)).toEqual(content);
    // jsonb reorders keys; the canonical form does not depend on the input order.
    const shuffled: unknown = JSON.parse(
      JSON.stringify({ variant: content.variant, item: content.item }),
    );
    expect(JSON.stringify(listingContentToJson(parseListingContent(shuffled)))).toBe(
      JSON.stringify(json),
    );
    expect(Object.keys(json)).toEqual(['item', 'variant']);
  });

  it.each([
    ['an unknown field', { variant: { ...sampleListingContent().variant, price2: 1 } }, 'variant'],
    ['a blank title', { variant: { ...sampleListingContent().variant, title: '  ' } }, 'title'],
    [
      'a fractional price',
      {
        variant: {
          ...sampleListingContent().variant,
          price: { amountCents: 1.5, currency: 'USD' },
        },
      },
      'variant.price.amountCents',
    ],
    [
      'another currency',
      {
        variant: {
          ...sampleListingContent().variant,
          price: { amountCents: 100, currency: 'EUR' },
        },
      },
      'variant.price.currency',
    ],
    [
      'a photo URL that is not http',
      {
        item: {
          ...sampleListingContent().item,
          photos: [{ photoId: 'p', position: 0, role: 'front', url: 'file:///etc/passwd' }],
        },
      },
      'item.photos.0.url',
    ],
    [
      'two photos in one position',
      {
        item: {
          ...sampleListingContent().item,
          photos: [
            { photoId: 'a', position: 0, role: 'front', url: 'https://media.listora.test/a.jpg' },
            { photoId: 'b', position: 0, role: 'back', url: 'https://media.listora.test/b.jpg' },
          ],
        },
      },
      'item.photos',
    ],
    [
      'an unknown condition',
      { item: { ...sampleListingContent().item, condition: 'mint' } },
      'condition',
    ],
  ])('rejects %s', (_case, change, message) => {
    const value = { ...sampleListingContent(), ...change };
    expect(() => parseListingContent(value)).toThrow(InvalidListingContentError);
    expect(() => parseListingContent(value)).toThrow(message);
  });

  it('rejects values that are not content at all', () => {
    for (const value of [null, [], 'listing', { item: sampleListingContent().item }]) {
      expect(() => parseListingContent(value)).toThrow(InvalidListingContentError);
    }
  });

  it('derives the state a read-back must show from the content', () => {
    const content = sampleListingContent();
    const fields = {
      title: content.variant.title,
      description: content.variant.description,
      priceCents: 4500,
      currency: 'USD',
    };
    expect(desiredStateForContent('create', content)).toEqual({ status: 'active', ...fields });
    expect(desiredStateForContent('revise', content)).toEqual(fields);
    expect(desiredStateForContent('relist', content)).toEqual({ status: 'active' });
  });

  it('knows which kinds carry content', () => {
    expect(
      ['create', 'revise', 'relist', 'price', 'end', 'mark_sold', 'verify'].filter(isContentKind),
    ).toEqual(['create', 'revise', 'relist']);
  });

  it('orders photos by position without changing the snapshot', () => {
    const { item } = sampleListingContent();
    expect(photosInOrder(item).map((photo) => photo.photoId)).toEqual([
      'photo-front',
      'photo-back',
      'photo-tag',
    ]);
    expect(item.photos.map((photo) => photo.photoId)).toEqual([
      'photo-tag',
      'photo-front',
      'photo-back',
    ]);
  });
});

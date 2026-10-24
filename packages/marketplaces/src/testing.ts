/**
 * Test helpers for other workspaces, imported as `@listora/marketplaces/testing`. Never imported
 * by runtime code. The Vitest-based conformance suite stays in conformance/ (this package's
 * adapters only).
 */
import type { ItemSnapshot, ListingContent, ListingVariant } from './content.ts';

export interface SampleContentOverrides {
  item?: Partial<ItemSnapshot>;
  variant?: Partial<ListingVariant>;
}

/**
 * Valid listing content for a realistic item: a denim jacket with three photos, listed out of
 * posting order, so a builder that forgets to sort them is caught.
 */
export function sampleListingContent(overrides: SampleContentOverrides = {}): ListingContent {
  const item: ItemSnapshot = {
    itemId: '0199a1f0-0000-7000-8000-000000000001',
    sku: 'AJ-000184',
    brand: "Levi's",
    productName: 'Trucker Jacket',
    styleNumber: '72334-0130',
    upc: null,
    department: 'men',
    category: 'clothing/outerwear/denim_jackets',
    sizeLabel: 'M',
    sizeSystem: 'us',
    colors: ['blue'],
    pattern: null,
    materials: ['100% cotton'],
    condition: 'pre_owned_excellent',
    conditionNotes: 'Light fading at the cuffs.',
    flaws: [],
    measurements: [{ name: 'pit_to_pit', value: 22, unit: 'in' }],
    photos: [
      {
        photoId: 'photo-tag',
        position: 2,
        role: 'tag',
        url: 'https://media.listora.test/p/tag.jpg',
      },
      {
        photoId: 'photo-front',
        position: 0,
        role: 'front',
        url: 'https://media.listora.test/p/front.jpg',
      },
      {
        photoId: 'photo-back',
        position: 1,
        role: 'back',
        url: 'https://media.listora.test/p/back.jpg',
      },
    ],
    ...overrides.item,
  };
  const variant: ListingVariant = {
    title: "Levi's Trucker Denim Jacket Men's M Blue",
    description: 'Classic trucker jacket in medium wash. Light fading at the cuffs.',
    price: { amountCents: 4500, currency: 'USD' },
    categoryRef: null,
    condition: null,
    aspects: [{ name: 'Size', values: ['M'] }],
    hashtags: [],
    ...overrides.variant,
  };
  return { item, variant };
}

/** Content whose variant has these listing fields (the rest from `sampleListingContent`). */
export function contentWith(fields: {
  title?: string;
  description?: string;
  priceCents?: number;
}): ListingContent {
  return sampleListingContent({
    variant: {
      ...(fields.title === undefined ? {} : { title: fields.title }),
      ...(fields.description === undefined ? {} : { description: fields.description }),
      ...(fields.priceCents === undefined
        ? {}
        : { price: { amountCents: fields.priceCents, currency: 'USD' } }),
    },
  });
}

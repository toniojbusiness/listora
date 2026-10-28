/**
 * What is recorded on Poshmark (docs/features/recorded-pages.md): the seller's own data (the
 * health check), their closet, one of their listings and its edit form, their sold items, and
 * the listing form filled for each of its form shapes (docs/features/poshmark.md, "Every form
 * shape, on the real form"), without photos and never listed.
 */
import type { ListingContent } from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import type { PhotoSource } from '../adapter/photos.ts';
import { automationProfile } from '../profiles.ts';
import {
  firstListingOnSale,
  present,
  RECORDING_SKU,
  type RecordingPlan,
  type RecordingPlanEntry,
} from '../recordings/plan.ts';
import type { ExpandedRecording } from '../recordings/recording.ts';
import { fillSku, openForm, privateSku, setAvailability } from './pages/listing-form.ts';
import { buildPoshmarkPayload } from './payload.ts';
import { createPoshmarkScripts, fillListing } from './scripts.ts';
import { PoshmarkSite } from './site.ts';

const site = new PoshmarkSite('https://poshmark.com');
/** No entry lists, so none gets a photo. */
const noPhotos: PhotoSource = {
  fetch: () => Promise.reject(new Error('a recording sends no photos')),
};
const scripts = createPoshmarkScripts({ site, photos: noPhotos });

const ref = (id: string) => ({
  listingId: 'recorded',
  externalListingId: id,
  externalSku: null,
  externalUrl: null,
});

/** One shape of the listing form: a category with its size sets, and a size in one. */
function shape(
  name: string,
  item: Partial<ListingContent['item']>,
  categoryRef: string | null = null,
): RecordingPlanEntry {
  const content = sampleListingContent({
    item: { colors: ['blue'], ...item },
    variant: { aspects: [], categoryRef },
  });
  return {
    name: `form-${name}`,
    page: 'sell-form',
    mode: 'form',
    content,
    script: () => async (step) => {
      // As a create fills it (scripts.ts), without the photos and never listed.
      const opened = await step('open the listing form', { mutates: false, timeScale: 2 }, (page) =>
        openForm(page, site.createListing()),
      );
      if (!opened) return 'no form';
      await fillListing(step, buildPoshmarkPayload(content.item, content.variant));
      await step('set the SKU and availability', { mutates: false }, async (page) => {
        await fillSku(page, RECORDING_SKU);
        await setAvailability(page, 'for_sale');
      });
      return 'filled';
    },
  };
}

export const poshmarkRecordingPlan: RecordingPlan = {
  marketplace: 'poshmark',
  profile: automationProfile('poshmark'),
  stepTimeoutMs: 30_000,
  sessionGapMs: 0,
  entries: [
    { name: 'hub', page: 'hub', mode: 'read', script: () => (step) => scripts.health(step) },
    {
      name: 'listings',
      page: 'shop',
      mode: 'read',
      script: () => (step) => present(scripts.listings)(null, step),
    },
    {
      name: 'listing',
      page: 'listing',
      mode: 'read',
      input: firstListingOnSale,
      script: (id) => (step) => scripts.read(ref(String(id)), step),
    },
    {
      name: 'edit',
      page: 'edit',
      mode: 'read',
      input: firstListingOnSale,
      script: (id) => (step) =>
        step('open the edit form', { mutates: false, timeScale: 2 }, async (page) =>
          (await openForm(page, site.editListing(String(id)))) ? privateSku(page) : 'no form',
        ),
    },
    {
      name: 'sold',
      page: 'sold',
      mode: 'read',
      script: () => (step) => present(scripts.orders)(null, step),
    },
    // No `offers` entry yet: Active Offers kept its list loading in the recorder's background tab
    // (2026-10-27), so its read stopped there (docs/features/offers.md, open items).
    shape('women-tops', {
      department: 'women',
      category: 'clothing/tops/t_shirts',
      sizeLabel: 'M',
    }),
    shape('women-jeans-plus', {
      department: 'women',
      category: 'clothing/bottoms/jeans',
      sizeLabel: '18W',
      sizeSystem: null,
    }),
    shape('women-dresses', {
      department: 'women',
      category: 'clothing/dresses/dresses',
      sizeLabel: 'M',
    }),
    shape('women-kurtas', { department: 'women', sizeLabel: 'M' }, 'Women/Kurtas'),
    shape('men-shirts-neck', {
      department: 'men',
      category: 'clothing/tops/shirts',
      sizeLabel: '15.5',
      sizeSystem: null,
      condition: 'new_with_tags',
    }),
    shape('men-jeans-waist', {
      department: 'men',
      category: 'clothing/bottoms/jeans',
      sizeLabel: '32x30',
      sizeSystem: 'waist_inseam',
    }),
    shape('men-shirts-big-tall', {
      department: 'men',
      category: 'clothing/tops/shirts',
      sizeLabel: '2XL',
      sizeSystem: 'letter',
    }),
    shape('men-other', { department: 'men', sizeLabel: null, sizeSystem: null }, 'Men/Other'),
    shape('kids-boys', {
      department: 'kids',
      category: 'clothing/tops/t_shirts',
      sizeLabel: 'Boys 8',
    }),
    shape(
      'kids-baby',
      { department: 'kids', sizeLabel: '6-9M', sizeSystem: null },
      'Kids/One Pieces',
    ),
    shape('kids-toys', { department: 'kids', sizeLabel: null, sizeSystem: null }, 'Kids/Toys'),
    shape('home-bedding', { department: null, category: 'home/bedding', sizeLabel: 'Queen' }),
    shape('home-accents', {
      department: null,
      category: 'home/decor',
      sizeLabel: null,
      colors: [],
    }),
    shape('pets', { department: null, sizeLabel: null, sizeSystem: null }, 'Pets/Dog'),
    shape(
      'electronics',
      { department: null, sizeLabel: null, sizeSystem: null },
      'Electronics/Headphones/Over-Ear Headphones',
    ),
  ],
  privateSelectors: [],
  identity: poshmarkIdentity,
};

/** The seller's username, which names their closet (`/closet/<username>`). */
function poshmarkIdentity(recordings: readonly ExpandedRecording[]): string[] {
  const usernames = new Set<string>();
  for (const recording of recordings) {
    for (const state of recording.states) {
      const found = /^\/closet\/([^/?#]+)/.exec(new URL(state.url).pathname)?.[1];
      if (found !== undefined) usernames.add(decodeURIComponent(found));
    }
  }
  return [...usernames];
}

/**
 * What is recorded on Depop (docs/features/recorded-pages.md): the selling hub, the seller's
 * listings for sale, one of them and its edit page, the sold items, and the sell form filled for
 * each of its 17 form shapes (a department and its size list; docs/features/depop-automation.md,
 * "Live verification"), without photos and never posted.
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
import { openEditor } from './pages/edit-page.ts';
import { expectSubmit, fillListing, openSellForm } from './pages/listing-form.ts';
import { buildDepopAutomationPayload } from './payload.ts';
import { createDepopScripts } from './scripts.ts';
import { DEPOP_SITE_URL, DEPOP_SLUG, depopSite } from './site.ts';

const site = depopSite(DEPOP_SITE_URL);
/** No entry posts, so none gets a photo. */
const noPhotos: PhotoSource = {
  fetch: () => Promise.reject(new Error('a recording sends no photos')),
};
const scripts = createDepopScripts({ site, photos: noPhotos });

const ref = (slug: string) => ({
  listingId: 'recorded',
  externalListingId: slug,
  externalSku: null,
  externalUrl: null,
});

/** One shape of the sell form: a product type of a department with its size list. */
function shape(
  name: string,
  categoryRef: string,
  item: Partial<ListingContent['item']>,
): RecordingPlanEntry {
  const content = sampleListingContent({
    item: { colors: ['blue'], materials: ['100% cotton'], ...item },
    variant: { categoryRef, aspects: [], hashtags: ['vintage'] },
  });
  return {
    name: `form-${name}`,
    page: 'sell-form',
    mode: 'form',
    content,
    script: () => (step) =>
      step('fill in the listing', { mutates: false, timeScale: 4 }, async (page) => {
        await openSellForm(page, site);
        await fillListing(
          page,
          buildDepopAutomationPayload(content.item, content.variant),
          RECORDING_SKU,
          null,
        );
        await expectSubmit(page, 'post');
        return 'filled';
      }),
  };
}

const sized = (sizeLabel: string, sizeSystem: ListingContent['item']['sizeSystem'] = 'letter') => ({
  sizeLabel,
  sizeSystem,
});
const unsized = { sizeLabel: null, sizeSystem: null } as const;

export const depopRecordingPlan: RecordingPlan = {
  marketplace: 'depop',
  profile: automationProfile('depop'),
  stepTimeoutMs: 30_000,
  sessionGapMs: 10 * 60_000,
  entries: [
    { name: 'hub', page: 'hub', mode: 'read', script: () => (step) => scripts.health(step) },
    {
      name: 'listings',
      page: 'shop',
      mode: 'read',
      script: () => (step) => present(scripts.listings)(null, step, new Set()),
    },
    {
      name: 'listing',
      page: 'listing',
      mode: 'read',
      input: firstListingOnSale,
      script: (slug) => (step) => scripts.read(ref(String(slug)), step),
    },
    {
      name: 'edit',
      page: 'edit',
      mode: 'read',
      input: firstListingOnSale,
      script: (slug) => (step) =>
        step('open the editor', { mutates: false }, (page) => openEditor(page, site, String(slug))),
    },
    {
      name: 'sold',
      page: 'sold',
      mode: 'read',
      script: () => (step) => present(scripts.orders)(null, step),
    },
    {
      name: 'offers',
      page: 'offers',
      mode: 'read',
      script: () => (step) => present(scripts.offers)(step),
    },
    shape('men-tops', 'Men > Tops > T-shirts', { department: 'men', ...sized('L') }),
    shape('men-bottoms', 'Men > Bottoms > Jeans', { department: 'men', ...sized('32', 'numeric') }),
    shape('men-outerwear', 'Men > Coats and jackets > Jackets', {
      department: 'men',
      ...sized('M'),
    }),
    shape('men-shoes', 'Men > Footwear > Sneakers', { department: 'men', ...sized('10.5', 'us') }),
    shape('men-underwear', 'Men > Underwear > Boxers and briefs', {
      department: 'men',
      ...sized('XL'),
    }),
    shape('men-accessories', 'Men > Accessories > Belts', { department: 'men', ...unsized }),
    shape('women-tops', 'Women > Tops > T-shirts', { department: 'women', ...sized('S') }),
    shape('women-bottoms', 'Women > Bottoms > Jeans', {
      department: 'women',
      ...sized('8', 'numeric'),
    }),
    shape('women-dresses', 'Women > Dresses > Casual dresses', {
      department: 'women',
      ...sized('4', 'numeric'),
    }),
    shape('women-outerwear', 'Women > Coats and jackets > Coats', {
      department: 'women',
      ...sized('M'),
    }),
    shape('women-shoes', 'Women > Footwear > Boots', { department: 'women', ...sized('8', 'us') }),
    shape('women-underwear', 'Women > Underwear > Bras', { department: 'women', ...sized('34B') }),
    shape('women-bags', 'Women > Accessories > Bags', { department: 'women', ...unsized }),
    shape('kids-clothing', 'Kids > Tops > T-shirts', {
      department: 'kids',
      ...sized('8', 'numeric'),
    }),
    shape('kids-shoes', 'Kids > Footwear > Sneakers', { department: 'kids', ...sized('11', 'us') }),
    shape('kids-accessories', 'Kids > Accessories > Hats and caps', {
      department: 'kids',
      ...unsized,
    }),
    shape('home', 'Everything else > Home > Home accessories', { department: null, ...unsized }),
    shape('makeup', 'Everything else > Beauty > Makeup', {
      department: 'women',
      ...unsized,
      condition: 'new_with_tags',
    }),
  ],
  privateSelectors: [],
  identity: depopIdentity,
};

/** The seller's username, which starts each of their product slugs (`<username>-<words>`). */
function depopIdentity(recordings: readonly ExpandedRecording[]): string[] {
  const usernames = new Set<string>();
  const visit = (value: unknown, key: string | null): void => {
    if (typeof value === 'string') {
      const slug = key === 'externalListingId' || key === 'externalOrderId';
      if (slug && DEPOP_SLUG.test(value)) usernames.add(value.slice(0, value.indexOf('-')));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
    } else if (value !== null && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) visit(child, name);
    }
  };
  for (const recording of recordings) {
    if (recording.name === 'listings' || recording.name === 'sold') visit(recording.result, null);
  }
  return [...usernames];
}

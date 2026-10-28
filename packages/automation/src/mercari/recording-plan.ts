/**
 * What is recorded on Mercari (docs/features/recorded-pages.md): the account page, the seller's
 * listings, one of them and its edit page, the sold items, and the sell form filled for each of
 * its form shapes (each size group, its petite and tall parts, and none; docs/features/mercari.md),
 * without photos and never listed.
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
import type { MercariSite } from './pages/common.ts';
import { openEditor } from './pages/edit-page.ts';
import { fillListing, openSellForm } from './pages/listing-form.ts';
import { buildMercariPayload } from './payload.ts';
import { createMercariScripts } from './scripts.ts';
import { MERCARI_SITE_URL } from './site.ts';

const site: MercariSite = { origin: MERCARI_SITE_URL };
/** No entry lists, so none gets a photo. */
const noPhotos: PhotoSource = {
  fetch: () => Promise.reject(new Error('a recording sends no photos')),
};
const scripts = createMercariScripts({ site, photos: noPhotos });

const ref = (id: string) => ({
  listingId: 'recorded',
  externalListingId: id,
  externalSku: null,
  externalUrl: null,
});

/** One shape of the sell form: a category of one of Mercari's size groups, and a size in it. */
function shape(
  name: string,
  categoryRef: string,
  item: Partial<ListingContent['item']>,
): RecordingPlanEntry {
  const content = sampleListingContent({
    item: { condition: 'new_with_tags', ...item },
    variant: { categoryRef },
  });
  return {
    name: `form-${name}`,
    page: 'sell-form',
    mode: 'form',
    content,
    script: () => (step) =>
      step('fill in the listing', { mutates: false, timeScale: 3 }, async (page) => {
        const opened = await openSellForm(page, site);
        if (opened !== 'form') return opened;
        return fillListing(
          page,
          buildMercariPayload(content.item, content.variant),
          RECORDING_SKU,
          null,
        );
      }),
  };
}

export const mercariRecordingPlan: RecordingPlan = {
  marketplace: 'mercari',
  profile: automationProfile('mercari'),
  stepTimeoutMs: 30_000,
  sessionGapMs: 10 * 60_000,
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
        step('open the editor', { mutates: false }, (page) => openEditor(page, site, String(id))),
    },
    {
      name: 'sold',
      page: 'sold',
      mode: 'read',
      script: () => (step) => present(scripts.orders)(null, step),
    },
    shape('women-dresses', 'Women > Dresses > Midi', { department: 'women', sizeLabel: '8' }),
    shape('men-tops', 'Men > Tops > T-shirts', { department: 'men', sizeLabel: 'XXL' }),
    shape('women-jeans', 'Women > Jeans > Skinny Jeans', {
      department: 'women',
      sizeLabel: 'W29 L30',
    }),
    shape('men-suits', 'Men > Suits > Two button', { department: 'men', sizeLabel: '40R' }),
    shape('women-shoes', 'Women > Shoes > Boots', { department: 'women', sizeLabel: '8 1/2' }),
    shape('kids-dresses', 'Kids > Girls dresses > Girls 2T-5T', {
      department: 'kids',
      sizeLabel: '3T',
    }),
    shape('kids-shoes', 'Kids > Boys shoes > Boys (4+)', { department: 'kids', sizeLabel: '2.5' }),
    shape('men-shoes', 'Men > Shoes > Athletic', { department: 'men', sizeLabel: '10' }),
    // Without a brand: Mercari's brand search answers slowly enough here that a live pick and its
    // replay disagree on what it offered (2026-10-27); the brand pick is recorded on every other
    // shape.
    shape('women-bras', 'Women > Underwear > Bras', {
      department: 'women',
      sizeLabel: '34DD',
      brand: null,
    }),
    shape('women-petite', 'Women > Dresses > Maxi', {
      department: 'women',
      sizeLabel: '4P',
      sizeSystem: null,
    }),
    shape('women-tall', 'Women > Pants > Casual pants', {
      department: 'women',
      sizeLabel: 'XL Tall',
      sizeSystem: null,
    }),
    shape('home', 'Home > Bedding > Quilts', { department: 'women', sizeLabel: null }),
    shape('beauty', 'Beauty > Makeup > Lips', { department: 'women', sizeLabel: null }),
  ],
  privateSelectors: [
    '[data-testid="DisplayName"]',
    '[data-testid="WelcomeUserName"]',
    '[data-testid="SellerInfoIntroduction"]',
  ],
  identity: mercariIdentity,
};

/** The seller's (and any buyer's) Mercari profile ids, from the links to their profiles. */
function mercariIdentity(recordings: readonly ExpandedRecording[]): string[] {
  const ids = new Set<string>();
  for (const recording of recordings) {
    for (const state of recording.states) {
      for (const line of state.lines) {
        for (const match of line.matchAll(/\/u\/(\d{4,20})\b/g)) {
          if (match[1] !== undefined) ids.add(match[1]);
        }
      }
    }
  }
  return [...ids];
}

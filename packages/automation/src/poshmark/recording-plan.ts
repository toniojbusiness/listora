/**
 * What is recorded on Poshmark (docs/features/recorded-pages.md): the seller's own data (the
 * health check), their closet, one of their listings and its edit form, their sold items, and
 * the listing form filled for each of its form shapes (docs/features/poshmark.md, "Every form
 * shape, on the real form"), without photos and never listed; and, logged out, the public
 * search a thrift scan comparison reads (docs/features/thrift-scan.md, "Poshmark").
 */
import type { ListingContent } from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import type { PhotoSource } from '../adapter/photos.ts';
import { poshmarkComparisonScript } from '../comps/poshmark.ts';
import { comparisonProfile } from '../comps/run.ts';
import type { ComparisonQuery } from '../comps/types.ts';
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

const POSHMARK_SITE_URL = 'https://poshmark.com';
const site = new PoshmarkSite(POSHMARK_SITE_URL);
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

/** The search entry's item: a pair of women's Levi's 501 jeans, size 28, as a scan names it. */
const SEARCH_QUERY: ComparisonQuery = {
  words: 'levis 501 jeans',
  brand: "Levi's",
  model: '501',
  sizeLabel: '28',
  productTypes: ['Women/Jeans'],
  typeWords: ['jeans'],
};
/**
 * The time the search's sales are dated against: the day of its recording, so a replay counts
 * the sales it did then (move it with a new recording).
 */
const SEARCH_NOW = new Date('2026-11-02T18:00:00Z');

export const poshmarkRecordingPlan: RecordingPlan = {
  marketplace: 'poshmark',
  profile: automationProfile('poshmark'),
  stepTimeoutMs: 30_000,
  sessionGapMs: 0,
  entries: [
    { name: 'hub', page: 'hub', mode: 'read', script: () => (step) => scripts.health(step) },
    {
      // The public search a comparison read makes (comps/), as a logged-out visitor: a fresh
      // browser context with no cookies, never the seller's session.
      name: 'search',
      page: 'search',
      mode: 'read',
      session: 'logged_out',
      profile: comparisonProfile('poshmark', {
        pacing: automationProfile('poshmark').readOnlyPacing,
      }),
      script: () => poshmarkComparisonScript(POSHMARK_SITE_URL, SEARCH_QUERY, SEARCH_NOW),
    },
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

/**
 * The seller's username, which names their closet (`/closet/<username>`); and in a public
 * search, every seller's: the usernames, handles, and names its results name them by.
 */
function poshmarkIdentity(recordings: readonly ExpandedRecording[]): string[] {
  const usernames = new Set<string>();
  const visit = (value: unknown, key: string | null): void => {
    if (typeof value === 'string') {
      if (key !== null && SEARCH_PERSON_KEYS.has(key) && value.trim() !== '') usernames.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
    } else if (value !== null && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) visit(child, name);
    }
  };
  for (const recording of recordings) {
    for (const state of recording.states) {
      const found = /^\/closet\/([^/?#]+)/.exec(new URL(state.url).pathname)?.[1];
      if (found !== undefined) usernames.add(decodeURIComponent(found));
      if (recording.page === 'search') visit(state.data, null);
    }
  }
  return [...usernames];
}

/** The keys a search result names its seller (or a commenter or liker) by. */
const SEARCH_PERSON_KEYS: ReadonlySet<string> = new Set([
  'creator_username',
  'creator_display_handle',
  'creator_full_name',
  'creator_fb_id',
  'username',
  'display_handle',
  'full_name',
]);

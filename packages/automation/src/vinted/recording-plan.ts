/**
 * What is recorded on Vinted (docs/features/recorded-pages.md): so far only, logged out, the
 * public search a thrift scan comparison reads (docs/features/thrift-scan.md, "Vinted"). The
 * seller's own pages join with Vinted's automation (docs/features/vinted.md, M2).
 */
import { comparisonProfile } from '../comps/run.ts';
import type { ComparisonQuery } from '../comps/types.ts';
import { VINTED_COMPARISON_PROFILE, vintedComparisonScript } from '../comps/vinted.ts';
import type { RecordingPlan } from '../recordings/plan.ts';
import { VINTED_SITE_URL } from './site.ts';

/** The search entry's item: a pair of women's Levi's 501 jeans, size 28, as a scan names it. */
const SEARCH_QUERY: ComparisonQuery = {
  words: 'levis 501 jeans',
  brand: "Levi's",
  model: '501',
  sizeLabel: '28',
  productTypes: [],
  typeWords: ['jeans', 'denim'],
};
/** Vinted dates nothing a visitor sees, so the search's result does not depend on the time. */
const SEARCH_NOW = new Date('2026-11-05T00:00:00Z');

export const vintedRecordingPlan: RecordingPlan = {
  marketplace: 'vinted',
  profile: VINTED_COMPARISON_PROFILE,
  stepTimeoutMs: 30_000,
  sessionGapMs: 10 * 60_000,
  entries: [
    {
      // The public search a comparison read makes (comps/), as a logged-out visitor: a fresh
      // browser context with no cookies, never a seller's session.
      name: 'search',
      page: 'search',
      mode: 'read',
      session: 'logged_out',
      profile: comparisonProfile('vinted', { pacing: VINTED_COMPARISON_PROFILE.readOnlyPacing }),
      script: () => vintedComparisonScript(VINTED_SITE_URL, SEARCH_QUERY, SEARCH_NOW),
    },
  ],
  privateSelectors: [],
  // The search's boxes name no seller: no username, handle, or name, only the item's own words.
  identity: () => [],
};

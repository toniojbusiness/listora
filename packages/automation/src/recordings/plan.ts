/**
 * What a marketplace's recording plan is (docs/features/recorded-pages.md): one entry per page
 * and form shape, each a script of the marketplace's own (its adapter's reads, or its page
 * modules' form filling) that the recorder runs on the seller's real pages and the replay test
 * runs on the recording. The plans are in the marketplaces' folders
 * (`<marketplace>/recording-plan.ts`), listed in plans.ts.
 */
import type { ListingContent } from '@listora/marketplaces';

import type { AutomationProfile } from '../profiles.ts';
import type { Script } from '../runner/types.ts';
import type { ExpandedRecording, RecordedMarketplace, RecordedPage } from './recording.ts';

export interface RecordingPlanEntry {
  name: string;
  page: RecordedPage;
  /**
   * `read`: runs as a read (no step may change anything, and no field takes input). `form`:
   * fills a form the way a create does, without photos, and never sends it.
   */
  mode: 'read' | 'form';
  /**
   * What the entry needs from what the earlier entries returned, by name (the id of a listing
   * the seller has for sale); `undefined` when the seller has nothing for it. Without it, the
   * entry needs nothing (`null`).
   */
  input?: (earlier: ReadonlyMap<string, unknown>) => unknown;
  /**
   * `logged_out`: the entry reads a page any visitor sees (a marketplace's public search), so
   * the recorder runs it in a fresh browser context that holds no cookies and never signed in,
   * never in the seller's own session. Every other entry runs in the seller's session.
   */
  session?: 'seller' | 'logged_out';
  /**
   * The profile the entry runs with, when it is not the plan's: a comparison read's, whose only
   * API is the site's own origin and which holds no cookie (comps/run.ts).
   */
  profile?: AutomationProfile;
  /** The listing a form entry fills in (`form` only). */
  content?: ListingContent;
  script: (input: unknown) => Script<unknown>;
}

export interface RecordingPlan {
  marketplace: RecordedMarketplace;
  /** The marketplace's own profile: its pacing, checks, and private parts. */
  profile: AutomationProfile;
  stepTimeoutMs: number;
  /**
   * The least time between two recording sessions on this marketplace (the recorder refuses to
   * start sooner): 10 minutes on Depop and Mercari.
   */
  sessionGapMs: number;
  entries: readonly RecordingPlanEntry[];
  /**
   * Parts of the marketplace's pages whose text is redacted in recordings besides the profile's
   * private parts (which failure screenshots black out): the seller's own name and profile text.
   */
  privateSelectors: readonly string[];
  /** Words that identify the seller in what was recorded (Depop's usernames in its slugs). */
  identity: (recordings: readonly ExpandedRecording[]) => string[];
}

/** The profile an entry runs and replays with. */
export function entryProfile(plan: RecordingPlan, entry: RecordingPlanEntry): AutomationProfile {
  return entry.profile ?? plan.profile;
}

/** The SKU a form entry's listing carries. */
export const RECORDING_SKU = 'REC-000001';

/** The first listing for sale in a `listings` entry's result, by its id. */
export function firstListingOnSale(earlier: ReadonlyMap<string, unknown>): string | undefined {
  const read = earlier.get('listings') as
    { listings?: { externalListingId?: string; status?: string }[] } | undefined;
  return read?.listings?.find((listing) => listing.status === 'active')?.externalListingId;
}

/** A script the marketplace's set has (its `listings` and `orders` are optional in general). */
export function present<T>(script: T | undefined): T {
  if (script === undefined) throw new Error("the marketplace's scripts have no such script");
  return script;
}

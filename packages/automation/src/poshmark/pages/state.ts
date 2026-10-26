/**
 * The data Poshmark's pages are rendered from. Every page embeds it as one inline script,
 * `window.__INITIAL_STATE__={...}` (read 2026-10-24), with the same listing records the site's
 * own API returns: ids, statuses, prices as decimal strings, and change times. Reads use it
 * rather than the visible text: it holds exact values (a price, a status code, a timestamp) where
 * the page shows formatted ones, and its keys change far less often than its markup.
 *
 * That script removes itself from the page as soon as it ran (`document.currentScript` is taken
 * out, read 2026-10-26), so by the time a page is ready its data is only in the page's global
 * `window.__INITIAL_STATE__`, which `pageData` reads.
 *
 * Every shape is checked; a page whose data no longer has what Listora reads throws
 * `PageChangedError`, so the step goes to the user instead of reading a wrong value.
 */
import { z } from 'zod';

import type { RemoteListingState, RemoteListingStatus } from '@listora/marketplaces';

import { PageChangedError } from '../../runner/errors.ts';
import type { PageDriver } from '../../runner/types.ts';
import type { PoshmarkSite } from '../site.ts';

/** The page global Poshmark's pages keep their data in. */
const STATE_GLOBAL = '__INITIAL_STATE__';

/** The page's embedded data; `page` names the page in errors ("the listing page"). */
export async function readPageState(driver: PageDriver, page: string): Promise<unknown> {
  const state = await driver.pageData(STATE_GLOBAL);
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new PageChangedError(`Poshmark's ${page} no longer embeds the data Listora reads`);
  }
  return state;
}

/** Checks `value` against `schema`; a mismatch names the page and the first missing field. */
export function expectShape<T>(schema: z.ZodType<T>, value: unknown, page: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const path = parsed.error.issues[0]?.path.map(String).join('.') ?? '';
  throw new PageChangedError(
    `Poshmark's ${page} no longer has the ${path === '' ? 'data' : path} Listora reads`,
  );
}

const money = z.object({ val: z.string(), currency_code: z.string() });

/** One listing, as listing and closet pages embed it. */
export const listingRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  /** `published` for a listing on the site. */
  status: z.string(),
  status_changed_at: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  price_amount: money,
  inventory: z.object({
    /** `available`, `not_for_sale`, `sold_out`, or `reserved` (a buyer is checking out). */
    status: z.string(),
    status_changed_at: z.string().optional(),
  }),
  creator_username: z.string().optional(),
});
export type ListingRecord = z.infer<typeof listingRecordSchema>;

/**
 * Who is logged in, on every page, as Poshmark's own app reads it (its store getters, read in its
 * public bundles 2026-10-26): `auth.isUserLoggedIn`, `auth.identity` the user's id (`null`
 * signed out), and the handle closets are addressed by in `userCookies.userInfo`, its
 * `username` or else its `dh` (display handle); signed out, `userCookies` has no `userInfo`.
 */
export const authSchema = z.object({
  auth: z.object({
    isUserLoggedIn: z.boolean(),
    identity: z.unknown(),
  }),
  userCookies: z
    .object({
      userInfo: z
        .object({ username: z.string().optional(), dh: z.string().optional() })
        .nullable()
        .optional(),
    })
    .optional(),
});

const INVENTORY_STATUSES: Readonly<Record<string, RemoteListingStatus>> = {
  available: 'active',
  // Reserved while a buyer checks out: still live until the sale goes through.
  reserved: 'active',
  not_for_sale: 'ended',
  sold_out: 'sold',
};

/** A listing record as a read-back: Listora's status, a cents price, and a revision. */
export function remoteListing(
  record: ListingRecord,
  site: PoshmarkSite,
  page: string,
): Extract<RemoteListingState, { found: true }> {
  const status = INVENTORY_STATUSES[record.inventory.status];
  if (status === undefined) {
    throw new PageChangedError(`Poshmark's ${page} shows a listing status Listora doesn't know`);
  }
  if (record.price_amount.currency_code !== 'USD') {
    throw new PageChangedError(`Poshmark's ${page} shows a price that is not in US dollars`);
  }
  return {
    found: true,
    externalListingId: record.id,
    externalUrl: site.listing(record.id),
    status,
    title: record.title,
    description: record.description,
    priceCents: cents(record.price_amount.val, page),
    currency: 'USD',
    revision: revision(record, page),
  };
}

/**
 * The listing's revision: its newest change time in milliseconds. Poshmark keeps `updated_at`
 * for edits and `status_changed_at` (the listing's and its inventory's) for availability
 * changes, each to the second. Listora's own changes to one seller's listings are always more
 * than a second apart (every change is its own browser session, and sessions are at least two
 * seconds apart, `PACING_FLOOR`), so each one has a newer revision.
 */
export function revision(record: ListingRecord, page: string): number {
  const times = [
    record.updated_at,
    record.status_changed_at,
    record.inventory.status_changed_at,
  ].flatMap((value) => (value === undefined ? [] : [Date.parse(value)]));
  const newest = Math.max(...times);
  if (!Number.isSafeInteger(newest) || newest < 0) {
    throw new PageChangedError(`Poshmark's ${page} shows a change time Listora can't read`);
  }
  return newest;
}

/** `"39.0"` → 3900. */
export function cents(value: string, page: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (match?.[1] === undefined) {
    throw new PageChangedError(`Poshmark's ${page} shows a price Listora can't read`);
  }
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}

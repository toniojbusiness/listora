/**
 * The Mercari automation adapter (decision D1, docs/mercari.md): Listora acts on Mercari, which
 * has no API, through the seller's own browser session in the browser runner. Its scripts drive
 * Mercari's pages through the page modules in `pages/` (one per page, with that page's
 * selectors), under the runner's safety rules: human pacing, rate limits, and a stop at any
 * CAPTCHA, Cloudflare check, or login challenge, after which the step is the user's task.
 *
 * - Create: fill the sell form (photos in order, title, description with the SKU line,
 *   category, brand, condition, size, shipping, price), then List; only that click mutates. A
 *   later attempt first looks for the listing by its SKU, so a create Mercari already took is
 *   never posted twice.
 * - Revise and price: the edit page's form, then Save. End: Deactivate (the listing is kept);
 *   relist: Activate. Mercari marks its own sales sold, so mark-sold is not needed.
 * - Read-back: the listing's page, with its last-updated time as the revision.
 * - Sale checks read the in-progress and sold tabs; the seller's active and inactive tabs list
 *   their listings for imports and drift checks.
 */
import {
  createMercariAdapter,
  type OperationRequest,
  type RemoteListingState,
  type RemoteListing,
  type RemoteOrder,
} from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import {
  AutomationAdapter,
  type AutomationScripts,
  type WriteResult,
} from '../adapter/automation-adapter.ts';
import type { PhotoSource } from '../adapter/photos.ts';
import type { AutomationSessions } from '../adapter/sessions.ts';
import { standInProfile, type AutomationProfile } from '../profiles.ts';
import type { PageDriver, StepRunner } from '../runner/types.ts';
import { openAccount } from './pages/account-page.ts';
import { changed, type MercariSite } from './pages/common.ts';
import { activate, deactivate, openEditor } from './pages/edit-page.ts';
import { itemUrl, readItem, readShownItem, type ItemRead } from './pages/item-page.ts';
import {
  fillListing,
  fillPrice,
  openSellForm,
  submitListing,
  type Submitted,
} from './pages/listing-form.ts';
import { readListingsPage } from './pages/listings-page.ts';
import {
  buildMercariPayload,
  listingSku,
  validateMercariPayload,
  type MercariListingPayload,
} from './payload.ts';
import { MERCARI_SITE_URL, type MercariListingTab } from './site.ts';

export interface MercariAdapterOptions {
  /** Mercari's profile, as configured (pacing and limits). */
  profile: AutomationProfile;
  sessions: AutomationSessions;
  photos: PhotoSource;
  logger: Logger;
  /**
   * Development and tests only: the fake Mercari site's URL, which then stands in for Mercari
   * (its origin becomes the profile's). Defaults to Mercari itself.
   */
  siteUrl?: string;
}

/**
 * How many of the newest active listings a lookup by SKU opens. A listing whose id Listora
 * never learned is one it just posted, so it is among the newest.
 */
export const SKU_LOOKUP_DEPTH = 8;
/** Pages of a listings tab one read goes through at most (newest first). */
export const MAX_LISTING_PAGES = 25;
/** Pages of a sold tab one sale check goes through at most (newest first). */
export const MAX_SOLD_PAGES = 5;

export function createMercariAutomationAdapter(
  options: MercariAdapterOptions,
): AutomationAdapter<MercariListingPayload> {
  const siteUrl = options.siteUrl ?? MERCARI_SITE_URL;
  const site: MercariSite = { origin: new URL(siteUrl).origin };
  const profile =
    options.siteUrl === undefined ? options.profile : standInProfile(options.profile, siteUrl);

  const notListed = (): WriteResult => ({
    type: 'rejected',
    code: 'not_listed',
    message: 'This listing is not on Mercari yet.',
  });
  const sold = (): WriteResult => ({
    type: 'rejected',
    code: 'listing_sold',
    message: 'This listing sold on Mercari, so it cannot be changed.',
    fixHint: 'List the item again as a new Mercari listing.',
  });

  /** The listing the newest active listings hold under this SKU, if any. */
  async function findBySku(step: StepRunner, sku: string): Promise<ItemRead | null> {
    const recent = await step('look at the newest listings', { mutates: false }, (page) =>
      readListingsPage(page, site, 'active', 1),
    );
    for (const row of recent.rows.slice(0, SKU_LOOKUP_DEPTH)) {
      const read = await step('look for the SKU', { mutates: false }, (page) =>
        readItem(page, site, row.id),
      );
      if (read.state.found && read.sku === sku) return read;
    }
    return null;
  }

  /** After a submit: Mercari's refusal, or the listing it opened, with its revision. */
  async function submitted(page: PageDriver, outcome: Submitted): Promise<WriteResult> {
    if (outcome.type === 'refused') {
      return { type: 'rejected', code: 'validation_failed', message: outcome.message };
    }
    const shown = await readShownItem(page, site);
    return {
      type: 'applied',
      externalListingId: outcome.itemId,
      ...(shown.state.found && shown.state.revision !== null
        ? { revision: shown.state.revision }
        : {}),
    };
  }

  /** Opens the editor of a listed, unsold listing; a result instead when it can't be edited. */
  async function editor(
    op: OperationRequest<MercariListingPayload>,
    step: StepRunner,
  ): Promise<{ id: string } | WriteResult> {
    const id = op.listing.externalListingId;
    if (id === null) return notListed();
    const opened = await step('open the editor', { mutates: false }, (page) =>
      openEditor(page, site, id),
    );
    if (opened === 'editing') return { id };
    const shown = await step('open the listing', { mutates: false }, (page) =>
      readItem(page, site, id),
    );
    if (!shown.state.found) return notListed();
    if (shown.state.status === 'sold') return sold();
    // An unsold listing whose edit page has no form: the page is not what Listora knows.
    throw changed('edit page', 'shows no listing form for a listing that has not sold');
  }

  const scripts: AutomationScripts<MercariListingPayload> = {
    create: async (op, step) => {
      const payload = op.payload;
      if (payload === null) throw new Error('a create has a payload');
      const sku = listingSku(op.listing);
      if (op.attempt > 1) {
        // An earlier attempt may have gone through; Mercari would take a second copy.
        const earlier = await findBySku(step, sku);
        if (earlier?.state.found === true) {
          return {
            type: 'applied',
            externalListingId: earlier.state.externalListingId,
            ...(earlier.state.revision === null ? {} : { revision: earlier.state.revision }),
          };
        }
      }
      const files = await step('get the photos', { mutates: false }, (_page, signal) =>
        Promise.all(payload.photos.map((photo) => options.photos.fetch(photo.url, signal))),
      );
      await step('fill in the listing', { mutates: false }, async (page) => {
        await openSellForm(page, site);
        await fillListing(page, payload, sku, files);
      });
      return step('list', { mutates: true }, async (page) =>
        submitted(page, await submitListing(page, 'list')),
      );
    },
    revise: async (op, step) => {
      const payload = op.payload;
      if (payload === null) throw new Error('a revise has a payload');
      const opened = await editor(op, step);
      if (!('id' in opened)) return opened;
      await step('fill in the changes', { mutates: false }, (page) =>
        fillListing(page, payload, listingSku(op.listing), null),
      );
      return step('save', { mutates: true }, async (page) =>
        submitted(page, await submitListing(page, 'save')),
      );
    },
    price: async (op, step) => {
      const priceCents = op.desired.priceCents;
      if (priceCents === undefined) {
        return { type: 'rejected', code: 'missing_price', message: 'There is no price to set.' };
      }
      if (priceCents % 100 !== 0 || priceCents < 100) {
        return {
          type: 'rejected',
          code: 'invalid_price',
          message: 'Mercari prices are whole dollars from $1.',
        };
      }
      const opened = await editor(op, step);
      if (!('id' in opened)) return opened;
      await step('fill in the price', { mutates: false }, (page) => fillPrice(page, priceCents));
      return step('save', { mutates: true }, async (page) =>
        submitted(page, await submitListing(page, 'save')),
      );
    },
    end: async (op, step) => {
      const id = op.listing.externalListingId;
      if (id === null) return notListed();
      const shown = await step('open the listing', { mutates: false }, (page) =>
        readItem(page, site, id),
      );
      if (!shown.state.found) return notListed();
      // Ended or sold: nothing is live, and the read-back decides.
      if (shown.state.status !== 'active') return { type: 'applied' };
      const opened = await editor(op, step);
      if (!('id' in opened)) return opened;
      return step('deactivate', { mutates: true }, async (page) => {
        await deactivate(page);
        return revisionOf(await readShownItem(page, site));
      });
    },
    relist: async (op, step) => {
      const id = op.listing.externalListingId;
      if (id === null) return notListed();
      const shown = await step('open the listing', { mutates: false }, (page) =>
        readItem(page, site, id),
      );
      if (!shown.state.found) return notListed();
      if (shown.state.status === 'active') return { type: 'applied', externalListingId: id };
      if (shown.state.status === 'sold') return sold();
      const opened = await editor(op, step);
      if (!('id' in opened)) return opened;
      return step('activate', { mutates: true }, async (page) => {
        await activate(page);
        return { ...revisionOf(await readShownItem(page, site)), externalListingId: id };
      });
    },
    read: async (ref, step): Promise<RemoteListingState> => {
      const id = ref.externalListingId;
      if (id !== null) {
        const read = await step('read the listing', { mutates: false }, (page) =>
          readItem(page, site, id),
        );
        return read.state;
      }
      // Found by SKU: not finding it is no proof the listing is gone.
      const found = await findBySku(step, listingSku(ref));
      return found?.state ?? { found: false, authoritative: false };
    },
    health: (step) =>
      step('open your account', { mutates: false }, (page) => openAccount(page, site)),
    orders: async (since, step) => {
      const orders: RemoteOrder[] = [];
      for (const tab of ['in_progress', 'sold'] as const) {
        for (let number = 1; number <= MAX_SOLD_PAGES; number += 1) {
          const shown = await step(
            `read the ${tab.replace('_', ' ')} sales`,
            { mutates: false },
            (page) => readListingsPage(page, site, tab, number),
          );
          for (const row of shown.rows) {
            if (row.soldAt === null || row.priceCents === null) continue;
            if (since !== null && row.soldAt < since) continue;
            // A Mercari listing sells once, so its id names the order.
            orders.push({
              externalOrderId: row.id,
              soldAt: row.soldAt,
              items: [
                {
                  externalListingId: row.id,
                  title: row.title,
                  priceCents: row.priceCents,
                  currency: 'USD',
                },
              ],
            });
          }
          // Newest first: a page that reaches past `since` is the last one needed.
          const oldest = shown.rows.at(-1)?.soldAt ?? null;
          if (!shown.hasNext || (since !== null && oldest !== null && oldest < since)) break;
        }
      }
      return orders;
    },
    listings: async (step) => {
      // Mercari's tabs show a listing's title and price but not its description or last
      // update, so those are `null`: a listing found here is never a read-back.
      const listings: RemoteListing[] = [];
      let complete = true;
      for (const [tab, status] of [
        ['active', 'active'],
        ['inactive', 'ended'],
      ] as const satisfies readonly (readonly [MercariListingTab, RemoteListing['status']])[]) {
        for (let number = 1; ; number += 1) {
          const shown = await step(`read the ${tab} listings`, { mutates: false }, (page) =>
            readListingsPage(page, site, tab, number),
          );
          for (const row of shown.rows) {
            listings.push({
              found: true,
              externalListingId: row.id,
              externalUrl: itemUrl(site, row.id),
              status,
              title: row.title,
              description: null,
              priceCents: row.priceCents,
              currency: row.priceCents === null ? null : 'USD',
              revision: null,
            });
          }
          if (!shown.hasNext) break;
          if (number === MAX_LISTING_PAGES) {
            complete = false;
            break;
          }
        }
      }
      return { listings, complete };
    },
  };

  return new AutomationAdapter<MercariListingPayload>({
    marketplace: 'mercari',
    profile,
    sessions: options.sessions,
    // A step automation can't do opens the real Mercari, where the user does it.
    assisted: createMercariAdapter(),
    scripts,
    readFreshness: 'revision',
    buildPayload: buildMercariPayload,
    validate: validateMercariPayload,
    logger: options.logger,
  });
}

/** An applied change, with the revision the listing page showed after it. */
function revisionOf(read: ItemRead): WriteResult {
  return read.state.found && read.state.revision !== null
    ? { type: 'applied', revision: read.state.revision }
    : { type: 'applied' };
}

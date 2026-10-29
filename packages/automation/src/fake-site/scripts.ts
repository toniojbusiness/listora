/**
 * The fake marketplace site's scripts (fake-site-adapter.ts describes them): the reference the
 * per-marketplace scripts follow, run by the browser runner and by the iPhone app
 * (docs/features/phone-execution.md) against the fake site in development and tests.
 */
import type {
  AssistedListingPayload,
  ListingRef,
  OperationRequest,
  RemoteListingState,
  RemoteListingStatus,
} from '@listora/marketplaces';
import { REMOTE_LISTING_STATUSES } from '@listora/marketplaces';

import type { PhotoSource } from '../adapter/photos.ts';
import {
  sellerIdentity,
  type AutomationScripts,
  type WriteResult,
} from '../adapter/script-call.ts';
import type { PageDriver, StepRunner } from '../runner/types.ts';

export interface FakeSiteScriptOptions {
  /** The fake site's origin. */
  site: string;
  photos: PhotoSource;
}

export function createFakeSiteScripts(
  options: FakeSiteScriptOptions,
): AutomationScripts<AssistedListingPayload> {
  const { site } = options;
  const sku = (ref: ListingRef): string => ref.externalSku ?? ref.listingId;
  const listingUrl = (id: string): string => `${site}/listings/${encodeURIComponent(id)}`;

  const notListed = (): WriteResult => ({
    type: 'rejected',
    code: 'not_listed',
    message: 'This listing is not on the marketplace yet.',
  });

  /** After a form was submitted: the form's validation message, or the listing it led to. */
  async function submitted(page: PageDriver): Promise<WriteResult> {
    const problem = await page.text('[data-error]');
    if (problem !== null) return { type: 'rejected', code: 'validation_failed', message: problem };
    await page.waitFor('article[data-listing-id]');
    const id = await page.attribute('article[data-listing-id]', 'data-listing-id');
    const revision = Number(await page.attribute('article[data-listing-id]', 'data-revision'));
    if (id === null) throw new Error('the listing page has no listing id');
    return {
      type: 'applied',
      externalListingId: id,
      ...(Number.isSafeInteger(revision) ? { revision } : {}),
    };
  }

  async function edit(
    op: OperationRequest<AssistedListingPayload>,
    step: StepRunner,
    fields: { title?: string; description?: string; priceCents?: number },
  ): Promise<WriteResult> {
    const id = op.listing.externalListingId;
    if (id === null) return notListed();
    const found = await step('open the editor', { mutates: false }, async (page) => {
      await page.goto(`${listingUrl(id)}/edit`);
      return page.exists('form #save');
    });
    if (!found) return notListed();
    await step('fill in the changes', { mutates: false }, async (page) => {
      if (fields.title !== undefined) await page.fill('#title', fields.title);
      if (fields.description !== undefined) await page.fill('#description', fields.description);
      if (fields.priceCents !== undefined) await page.fill('#price', dollars(fields.priceCents));
    });
    return step('save', { mutates: true }, async (page) => {
      await page.click('#save');
      return submitted(page);
    });
  }

  async function readById(page: PageDriver, id: string): Promise<RemoteListingState> {
    await page.goto(listingUrl(id));
    if (page.status() === 410 || (await page.exists('[data-removed]'))) {
      return { found: false, authoritative: true };
    }
    if (page.status() === 404 || !(await page.exists('article[data-listing-id]'))) {
      return { found: false, authoritative: false };
    }
    const attribute = (name: string) => page.attribute('article[data-listing-id]', name);
    const status = await attribute('data-status');
    if (!isStatus(status)) throw new Error('the listing page shows an unknown status');
    const price = Number(await page.attribute('[data-field="price"]', 'data-cents'));
    const revision = Number(await attribute('data-revision'));
    return {
      found: true,
      externalListingId: (await attribute('data-listing-id')) ?? id,
      externalUrl: listingUrl(id),
      status,
      title: await page.text('[data-field="title"]'),
      description: await page.text('[data-field="description"]'),
      priceCents: Number.isSafeInteger(price) ? price : null,
      currency: 'USD',
      revision: Number.isSafeInteger(revision) ? revision : null,
      refreshedAt: await attribute('data-refreshed-at'),
    };
  }

  return {
    create: async (op, step) => {
      const payload = op.payload;
      if (payload === null) throw new Error('a create has a payload');
      const existing = await step('look the listing up', { mutates: false }, async (page) => {
        await page.goto(`${site}/listings?sku=${encodeURIComponent(sku(op.listing))}`);
        return page.attribute('[data-listing-id]', 'data-listing-id');
      });
      if (existing !== null) return { type: 'applied', externalListingId: existing };
      const files = await step('get the photos', { mutates: false }, (_page, signal) =>
        Promise.all(payload.photos.map((photo) => options.photos.fetch(photo.url, signal))),
      );
      await step('fill in the listing', { mutates: false }, async (page) => {
        await page.goto(`${site}/listings/new`);
        await page.fill('#title', payload.title);
        await page.fill('#description', payload.description);
        await page.fill('#price', dollars(payload.price.amountCents));
        await page.fill('#sku', sku(op.listing));
        await page.upload('#photos', files);
      });
      return step('publish', { mutates: true }, async (page) => {
        await page.click('#save');
        return submitted(page);
      });
    },
    revise: (op, step) => {
      const payload = op.payload;
      if (payload === null) throw new Error('a revise has a payload');
      return edit(op, step, {
        title: payload.title,
        description: payload.description,
        priceCents: payload.price.amountCents,
      });
    },
    price: (op, step) =>
      op.desired.priceCents === undefined
        ? Promise.resolve({
            type: 'rejected',
            code: 'missing_price',
            message: 'There is no price to set.',
          })
        : edit(op, step, { priceCents: op.desired.priceCents }),
    end: async (op, step) => {
      const id = op.listing.externalListingId;
      if (id === null) return notListed();
      const shown = await step('open the listing', { mutates: false }, (page) =>
        readById(page, id),
      );
      if (!shown.found) return notListed();
      if (shown.status !== 'active') return { type: 'applied' };
      return step('delete', { mutates: true }, async (page) => {
        page.acceptNextDialog();
        await page.click('#delete');
        await page.waitFor('article[data-status="ended"]');
        return { type: 'applied' };
      });
    },
    relist: async (op, step) => {
      const id = op.listing.externalListingId;
      if (id === null) return notListed();
      const shown = await step('open the listing', { mutates: false }, (page) =>
        readById(page, id),
      );
      if (!shown.found) return notListed();
      if (shown.status === 'active') return { type: 'applied', externalListingId: id };
      return step('relist', { mutates: true }, async (page) => {
        await page.click('#relist');
        return submitted(page);
      });
    },
    refresh: async (op, step) => {
      const id = op.listing.externalListingId;
      if (id === null) return notListed();
      const shown = await step('open the listing', { mutates: false }, (page) =>
        readById(page, id),
      );
      if (!shown.found) return notListed();
      if (shown.status !== 'active') {
        return {
          type: 'rejected',
          code: 'not_live',
          message: 'Only a live listing can be refreshed.',
        };
      }
      return step('refresh', { mutates: true }, async (page) => {
        await page.click('#refresh');
        return submitted(page);
      });
    },
    read: (ref, step) =>
      step('read the listing', { mutates: false }, async (page) => {
        if (ref.externalListingId !== null) return readById(page, ref.externalListingId);
        await page.goto(`${site}/listings?sku=${encodeURIComponent(sku(ref))}`);
        const id = await page.attribute('[data-listing-id]', 'data-listing-id');
        if (id === null) return { found: false, authoritative: false };
        const remote = await readById(page, id);
        // Found by SKU: a missing page is no proof the listing is gone.
        return remote.found ? remote : { found: false, authoritative: false };
      }),
    health: (step) =>
      step('open the account', { mutates: false }, async (page) => {
        await page.goto(`${site}/`);
        if (!(await page.exists('[data-account]'))) throw new Error('not the account page');
        return sellerIdentity(await page.attribute('[data-account]', 'data-account'));
      }),
    orders: (since, step) =>
      step('open the sold orders', { mutates: false }, async (page) => {
        await page.goto(`${site}/sold`);
        const [ids, soldAts, listings, prices] = await Promise.all([
          page.attributes('[data-order-id]', 'data-order-id'),
          page.attributes('[data-order-id]', 'data-sold-at'),
          page.attributes('[data-order-id]', 'data-listing-id'),
          page.attributes('[data-order-id]', 'data-price-cents'),
        ]);
        return ids.flatMap((id, index) => {
          const soldAt = new Date(soldAts[index] ?? '');
          const priceCents = Number(prices[index]);
          if (id === null || Number.isNaN(soldAt.getTime()) || !Number.isSafeInteger(priceCents)) {
            return [];
          }
          if (since !== null && soldAt < since) return [];
          return [
            {
              externalOrderId: id,
              soldAt,
              items: [
                {
                  externalListingId: listings[index] ?? null,
                  title: null,
                  priceCents,
                  currency: 'USD' as const,
                },
              ],
            },
          ];
        });
      }),
  };
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function isStatus(value: string | null): value is RemoteListingStatus {
  return value !== null && (REMOTE_LISTING_STATUSES as readonly string[]).includes(value);
}

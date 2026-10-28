/**
 * The server reads an app's answers whatever its runtime: an app built before sales history (its
 * sale checks send orders without the sold listing, the shipped state, or fees) is read as it was,
 * and a newer app's orders with them are read whole. The call protocol (PHONE_RUNTIME_VERSION)
 * didn't change, so an older app keeps taking every call.
 */
import { describe, expect, it } from 'vitest';

import { readPhoneAnswer } from './answers.ts';
import { PHONE_RUNTIME_VERSION } from './runtime.ts';

const call = { script: 'orders', since: null } as const;

const ran = (value: unknown) => ({
  type: 'ran',
  result: { ok: true, value, mutated: false, steps: ['read the sold sales'] },
});

describe("the server reads an app's sale-check answers, old and new", () => {
  it('speaks the runtime version apps built before sales history speak', () => {
    expect(PHONE_RUNTIME_VERSION).toBe(2);
  });

  it("reads an older app's orders as they were: no listing, shipped state, or fees", () => {
    const order = {
      externalOrderId: 'm61000000001',
      soldAt: '2026-10-27T10:00:00.000Z',
      items: [
        {
          externalListingId: 'm61000000001',
          title: 'Wool scarf',
          priceCents: 1100,
          currency: 'USD',
        },
      ],
    };
    expect(readPhoneAnswer(call, ran([order]))).toEqual({
      type: 'ran',
      result: {
        ok: true,
        mutated: false,
        steps: ['read the sold sales'],
        value: [{ ...order, soldAt: new Date(order.soldAt) }],
      },
    });
  });

  it("reads an older app's Depop sale check that stopped at a page it doesn't know", () => {
    const failed = {
      type: 'ran',
      result: {
        ok: false,
        mutated: false,
        steps: ['read the sold items'],
        failure: {
          kind: 'error',
          step: 'read the sold items',
          code: 'element_missing',
          message: "Depop's sold items page lists sales in a way Listora cannot read yet",
          retryAfterMs: null,
        },
      },
    };
    expect(readPhoneAnswer(call, failed)).toMatchObject({
      type: 'ran',
      result: { ok: false, failure: { code: 'element_missing', screenshotKey: null } },
    });
  });

  it("reads a newer app's orders with the sold listing, the shipped state, and fees", () => {
    const listing = {
      found: true,
      externalListingId: 'shop-denim-jacket-1',
      externalUrl: 'https://www.depop.com/products/shop-denim-jacket-1/',
      status: 'sold',
      title: null,
      description: 'Denim jacket',
      priceCents: 4500,
      currency: 'USD',
      revision: 1_761_000_000_000,
      details: {
        photoUrls: ['https://media-photos.depop.com/fake/P0.jpg'],
        brand: null,
        size: 'M',
        condition: null,
        categoryRef: null,
        categoryPath: [],
        sku: null,
      },
    };
    const order = {
      externalOrderId: '7000001',
      soldAt: '2026-10-27T10:00:00.000Z',
      shipped: true,
      fees: [
        { kind: 'marketplace', description: "Depop's fees", amountCents: 380, currency: 'USD' },
      ],
      items: [
        {
          externalListingId: 'shop-denim-jacket-1',
          title: 'Denim jacket',
          priceCents: 3800,
          currency: 'USD',
          listing,
        },
      ],
    };
    const read = readPhoneAnswer(call, ran([order]));
    expect(read).toMatchObject({
      type: 'ran',
      result: { ok: true, value: [{ ...order, soldAt: new Date(order.soldAt) }] },
    });
  });
});

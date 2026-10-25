/**
 * Depop webhooks: `X-Depop-Signature` verification against Depop's documented algorithm, the
 * events Listora reads, and a signed delivery from the fake Depop to a real HTTP endpoint.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import { FakeDepop } from './fake/fake-depop.ts';
import {
  depopWebhookSignature,
  parseDepopWebhook,
  receiveDepopWebhook,
  verifyDepopWebhook,
  type DepopWebhookReceipt,
} from './webhooks.ts';

const SECRET = 'rncxmdh5v2b37etli3ajb0e8f3xvopel';
const REFUND =
  '{"id":"a210923f-c1f3-4d84-a2bd-7f18c68553e2","event_type":"v1:order.refund","created_at":"2025-01-01T00:00:00Z","data":{"purchase_id":"123456","refunded_by":"PARTNER"}}';
const AT = 1_735_689_600;

describe('X-Depop-Signature', () => {
  it("matches Depop's own algorithm: HMAC-SHA256 of <timestamp>.<body>, hex", () => {
    // Computed with the Python of Depop's "Validate webhooks" guide.
    expect(depopWebhookSignature(SECRET, String(AT), REFUND)).toBe(
      'a5e006b08bf81525a568459b99118d186742b40af7b789ba4da044f0e8df1834',
    );
  });

  const check = (overrides: Partial<Parameters<typeof verifyDepopWebhook>[0]> = {}) =>
    verifyDepopWebhook({
      rawBody: REFUND,
      signature: depopWebhookSignature(SECRET, String(AT), REFUND),
      timestamp: String(AT),
      secret: SECRET,
      now: AT * 1000 + 60_000,
      ...overrides,
    });

  it('accepts a genuine delivery within five minutes', () => {
    expect(check()).toEqual({ ok: true });
  });

  it('refuses a tampered body, another secret, a replay, and a malformed or missing header', () => {
    expect(check({ rawBody: REFUND.replace('PARTNER', 'DEPOP') })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    // A re-serialized body is not what Depop signed.
    expect(check({ rawBody: JSON.stringify(JSON.parse(REFUND), null, 1) })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(check({ secret: 'another-secret' })).toEqual({ ok: false, reason: 'mismatch' });
    expect(check({ now: AT * 1000 + 301_000 })).toEqual({ ok: false, reason: 'stale' });
    expect(check({ signature: 'not-hex' })).toEqual({ ok: false, reason: 'malformed' });
    expect(check({ timestamp: undefined })).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('parseDepopWebhook', () => {
  const envelope = (eventType: string, data: unknown, id = 'evt-1') =>
    JSON.stringify({ id, event_type: eventType, created_at: '2026-10-24T12:00:00Z', data });

  const line = {
    purchase_item_id: 2385551,
    sku: 'AJ-000184-D1',
    product_id: 7021251,
    slug: 'levis-trucker-7021251',
    parcel_id: '6e3538ca-6653-3c25-bf0a-a2be876b17e4',
    description: 'Trucker jacket',
    original_price: '45.00',
    sold_price: '40.00',
    sold_via_offers: true,
    image_url: 'https://media-photos.depop.com/P0.jpg',
  };
  const order = {
    seller_id: 123456,
    purchase_id: '435017619960',
    status: 'SHIPPING_PENDING',
    currency: 'USD',
    buyer_pays_amount: '44.99',
    seller_receives_amount: '37.50',
    fee_amount: '2.50',
    buyer_shipping_price: '4.99',
    buyer_address: { name: 'Buyer', country: 'US' },
    line_items: [line],
  };

  it('reads a new order into cents, keyed for deduplication by id, type, and time', () => {
    const event = parseDepopWebhook(envelope('v1:order.new', order));
    expect(event).toEqual({
      providerEventId: 'evt-1:v1:order.new:2026-10-24T12:00:00Z',
      createdAt: '2026-10-24T12:00:00Z',
      type: 'order_new',
      order: {
        purchaseId: '435017619960',
        sellerId: 123456,
        status: 'SHIPPING_PENDING',
        currency: 'USD',
        buyerPaysCents: 4499,
        sellerReceivesCents: 3750,
        buyerShippingCents: 499,
        createdAt: null,
        lines: [
          {
            purchaseItemId: 2385551,
            sku: 'AJ-000184-D1',
            productId: 7021251,
            slug: 'levis-trucker-7021251',
            soldPriceCents: 4000,
            originalPriceCents: 4500,
            soldViaOffers: true,
          },
        ],
        fees: [],
        feeTotalCents: 250,
      },
    });
    // An update of the same order shares the id but not the key.
    expect(
      parseDepopWebhook(envelope('v1:order.update', { ...order, status: 'SHIPPED' }))
        .providerEventId,
    ).toBe('evt-1:v1:order.update:2026-10-24T12:00:00Z');
  });

  it('reads refunds, product changes, and likes, and keeps unknown events for acknowledging', () => {
    expect(parseDepopWebhook(REFUND)).toMatchObject({
      type: 'order_refund',
      purchaseId: '123456',
      refundedBy: 'PARTNER',
    });
    const product = {
      sku: 'AJ-000184-D1',
      product_id: 7021251,
      slug: 'levis-trucker-7021251',
      status: 'STATUS_ONSALE',
      description: 'Trucker jacket\n\n#vintage',
      price_currency: 'USD',
      price_amount: '45.00',
      quantity: 1,
    };
    expect(
      parseDepopWebhook(envelope('v1:product.update', { seller_id: 1, product })),
    ).toMatchObject({
      type: 'product_update',
      sellerId: 1,
      product: { sku: 'AJ-000184-D1', status: 'STATUS_ONSALE' },
    });
    expect(
      parseDepopWebhook(
        envelope('v1:product.like', {
          seller_id: 1,
          product_id: 2,
          sku: null,
          slug: 's',
          liker_id: 3,
        }),
      ),
    ).toMatchObject({ type: 'product_like', productId: 2, sku: null });
    expect(parseDepopWebhook(envelope('v2:order.new', {}))).toMatchObject({
      type: 'unknown',
      eventType: 'v2:order.new',
    });
  });

  it('refuses a body that is not the event its type says', () => {
    expect(() => parseDepopWebhook('not json')).toThrow('not JSON');
    expect(() =>
      parseDepopWebhook(envelope('v1:order.new', { ...order, buyer_pays_amount: 'free' })),
    ).toThrow('unexpected payload');
  });
});

describe('a signed delivery from the fake Depop', () => {
  it('arrives with headers whose signature verifies over the raw body, after a purchase', async () => {
    const received: DepopWebhookReceipt[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push(
          receiveDepopWebhook({
            headers: request.headers,
            rawBody: Buffer.concat(chunks).toString('utf8'),
            secret: SECRET,
            now: Date.now(),
          }),
        );
        response.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/webhooks/depop`;
    const fake = await FakeDepop.start({ webhook: { url: endpoint, secret: SECRET } });
    try {
      const token = await fetch(`${fake.url}/api/v1/oauth2/access-token/`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: fake.grant(fake.developmentSellerId),
          client_id: 'listora-fake-depop-client',
          client_secret: 'listora-fake-depop-client-secret',
        }).toString(),
      }).then(
        async (response) => ((await response.json()) as { access_token: string }).access_token,
      );
      const put = await fetch(`${fake.url}/api/v1/products/by-sku/AJ-000184-D1/`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          address: { country_code: 'US' },
          description: 'Trucker jacket',
          price_currency: 'USD',
          price_amount: '45.00',
          quantity: 1,
          pictures: [{ url: 'https://media.listora.test/p/front.jpg' }],
          department: 'menswear',
          product_type: 'tshirts',
          condition: 'used_good',
          brand_name: "Levi's",
          attributes: {},
          depop_shipping: {
            address_id: 100001,
            shipping_provider_id: 'USPS',
            parcel_size_id: 'SMALL',
            payer: 'buyer',
          },
        }),
      });
      expect(put.status).toBe(200);
      const order = fake.purchase('AJ-000184-D1');
      await expect.poll(() => received.length).toBe(1);
      expect(received[0]).toMatchObject({
        ok: true,
        event: {
          type: 'order_new',
          order: { purchaseId: order.purchase_id, lines: [{ sku: 'AJ-000184-D1' }] },
        },
      });
      // A delivery signed with another secret is refused.
      const forged = fake.orderWebhook(order, { secret: 'not-the-secret' });
      expect(await fake.deliver(endpoint, forged)).toBe(200);
      expect(received[1]).toEqual({ ok: false, reason: 'mismatch' });
      expect(fake.specViolations).toEqual([]);
    } finally {
      await fake.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});

/**
 * The fake Depop stays true to Depop's published contract: the vendored openapi.yaml is
 * Depop's own, requests that break it are refused, every response it sends matches it, and the
 * documented rules, rate limits, and token rotation hold.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FAKE_DEPOP_ADDRESS_ID,
  FAKE_DEPOP_CLIENT_ID,
  FAKE_DEPOP_CLIENT_SECRET,
} from './constants.ts';
import { FakeDepop } from './fake-depop.ts';
import { DEPOP_OPENAPI_SOURCE, depopSpecSha256, loadDepopSpec } from './spec.ts';

/** A full listing as the Selling API takes it (ProductPutRequest). */
const listing = (changes: Record<string, unknown> = {}) => ({
  address: { country_code: 'US', state: 'California' },
  description: 'Faded denim jacket\n\n#vintage',
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
    address_id: FAKE_DEPOP_ADDRESS_ID,
    shipping_provider_id: 'USPS',
    parcel_size_id: 'SMALL',
    payer: 'buyer',
  },
  ...changes,
});

describe('the vendored Depop spec', () => {
  it("is Depop's openapi.yaml, byte for byte", () => {
    expect(depopSpecSha256()).toBe(DEPOP_OPENAPI_SOURCE.sha256);
  });

  it('describes every operation the adapter uses', () => {
    const spec = loadDepopSpec();
    for (const [method, path, operationId] of [
      ['PUT', '/api/v1/products/by-sku/AJ-000184-D1/', 'createOrUpdateProduct'],
      ['PATCH', '/api/v1/products/by-sku/AJ-000184-D1/', 'patchProduct'],
      ['DELETE', '/api/v1/products/by-sku/AJ-000184-D1/', 'deleteProduct'],
      ['GET', '/api/v1/products/by-sku/AJ-000184-D1/', 'getProductBySku'],
      ['POST', '/api/v1/products/by-sku/AJ-000184-D1/mark-as-sold/', 'markProductAsSold'],
      ['GET', '/api/v1/products/by-slug/faded-denim-7000001/', 'getProductBySlug'],
      ['GET', '/api/v1/orders/', 'getAllOrders'],
      ['GET', '/api/v1/shop/', 'getSellerDetails'],
      ['POST', '/api/v1/oauth2/access-token/', 'exchangeToken'],
    ] as const) {
      expect(spec.match(method, path)?.operation.operationId, `${method} ${path}`).toBe(
        operationId,
      );
    }
  });
});

describe('FakeDepop', () => {
  let fake: FakeDepop;
  let token: string;

  beforeAll(async () => {
    fake = await FakeDepop.start({ rateLimits: { other: { requests: 50, windowMs: 60_000 } } });
    token = await accessToken(fake.grant(fake.developmentSellerId));
  });

  afterAll(async () => {
    expect(fake.specViolations).toEqual([]);
    await fake.close();
  });

  async function accessToken(refreshToken: string): Promise<string> {
    const response = await fetch(`${fake.url}/api/v1/oauth2/access-token/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: FAKE_DEPOP_CLIENT_ID,
        client_secret: FAKE_DEPOP_CLIENT_SECRET,
      }).toString(),
    });
    return ((await response.json()) as { access_token: string }).access_token;
  }

  async function call(method: string, path: string, body?: unknown, bearer = token) {
    const response = await fetch(`${fake.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text === '' ? null : (JSON.parse(text) as Record<string, unknown>),
    };
  }

  const errorCode = (body: Record<string, unknown> | null) =>
    (body?.['errors'] as { code: string }[] | undefined)?.[0]?.code;

  it('creates under a SKU, updates under the same SKU, and keeps the product id and slug', async () => {
    const created = await call('PUT', '/api/v1/products/by-sku/FK-000001-D1/', listing());
    expect(created).toMatchObject({
      status: 200,
      body: { sku: 'FK-000001-D1', product_id: expect.any(Number) as number },
    });
    const updated = await call(
      'PUT',
      '/api/v1/products/by-sku/FK-000001-D1/',
      listing({ price_amount: '39.00' }),
    );
    expect(updated.body).toEqual(created.body);
    const read = await call('GET', '/api/v1/products/by-sku/FK-000001-D1/');
    expect(read.body).toMatchObject({
      status: 'STATUS_ONSALE',
      price_amount: '39.00',
      brand: "Levi's",
    });
    expect(
      await call('GET', `/api/v1/products/by-slug/${String(created.body?.['slug'])}/`),
    ).toMatchObject({ status: 200 });
  });

  it('refuses requests that break the spec or the documented rules', async () => {
    const put = (sku: string, body: unknown) =>
      call('PUT', `/api/v1/products/by-sku/${sku}/`, body);
    const cases: [string, unknown, number, string][] = [
      ['FK-000002-D1', { description: 'x' }, 422, 'validation'],
      ['FK-000002-D1', 'not json', 400, 'bad-request'],
      ['X'.repeat(51), listing(), 400, 'bad-request'],
      [
        'FK-000002-D1',
        listing({ pictures: Array.from({ length: 9 }, () => ({ url: 'https://p.test/a.jpg' })) }),
        422,
        'too_many_pictures',
      ],
      ['FK-000002-D1', listing({ description: 'x #a #b #c #d #e #f' }), 422, 'invalid_description'],
      ['FK-000002-D1', listing({ description: 'mail me@example.com' }), 422, 'invalid_description'],
      ['FK-000002-D1', listing({ price_amount: '0.99' }), 422, 'validation'],
      ['FK-000002-D1', listing({ price_currency: 'GBP' }), 422, 'validation'],
      ['FK-000002-D1', listing({ department: 'unisex' }), 422, 'invalid_department'],
      [
        'FK-000002-D1',
        listing({ pictures: [{ url: 'http://p.test/a.jpg' }] }),
        422,
        'ingest_picture_error',
      ],
      [
        'FK-000002-D1',
        listing({ depop_shipping: undefined, national_shipping_cost: '4.00' }),
        422,
        'manual_shipping_not_allowed',
      ],
      [
        'FK-000002-D1',
        listing({
          depop_shipping: {
            address_id: 1,
            shipping_provider_id: 'USPS',
            parcel_size_id: 'SMALL',
            payer: 'buyer',
          },
        }),
        422,
        'generic_error',
      ],
      ['FK-000002-D1', listing({ size_id: 10 }), 422, 'invalid_size'],
    ];
    for (const [sku, body, status, code] of cases) {
      const answer = await put(sku, body);
      expect([answer.status, errorCode(answer.body)], code).toEqual([status, code]);
    }
    expect(fake.products('FK-000002-D1')).toEqual([]);
  });

  it('never reuses a SKU, deletes idempotently, and marks sold only what is on sale', async () => {
    const path = '/api/v1/products/by-sku/FK-000003-D1/';
    await call('PUT', path, listing({ size_set_id: 52, size_id: 10 }));
    expect(
      errorCode((await call('PUT', path, listing({ size_set_id: 52, size_id: 11 }))).body),
    ).toBe('validation');
    expect((await call('DELETE', path)).status).toBe(200);
    expect((await call('DELETE', path)).status).toBe(200);
    expect((await call('DELETE', '/api/v1/products/by-sku/NEVER-EXISTED/')).status).toBe(200);
    expect((await call('GET', path)).body).toMatchObject({ status: 'STATUS_DELETED_ONSALE' });
    expect(errorCode((await call('PUT', path, listing())).body)).toBe('duplicate_sku');
    expect(errorCode((await call('PATCH', path, { price_amount: '20.00' })).body)).toBe(
      'product_not_on_sale',
    );
    expect((await call('POST', `${path}mark-as-sold/`)).status).toBe(200);
    expect((await call('GET', path)).body).toMatchObject({ status: 'STATUS_DELETED_ONSALE' });
    expect((await call('POST', '/api/v1/products/by-sku/NEVER-EXISTED/mark-as-sold/')).status).toBe(
      404,
    );
    expect((await call('GET', '/api/v1/products/by-sku/NEVER-EXISTED/')).status).toBe(404);
  });

  it('serves stale reads and reads that cannot see a product yet, on request', async () => {
    const path = '/api/v1/products/by-sku/FK-000004-D1/';
    await call('PUT', path, listing());
    await call('PATCH', path, { price_amount: '30.00' });
    fake.inject({ action: 'get', fault: { type: 'stale_read' } });
    expect((await call('GET', path)).body).toMatchObject({ price_amount: '45.00' });
    expect((await call('GET', path)).body).toMatchObject({ price_amount: '30.00' });
    fake.inject({ action: 'get', fault: { type: 'not_visible' } });
    expect(errorCode((await call('GET', path)).body)).toBe('product_not_found');
  });

  it("enforces Depop's rate limits with the documented 429", async () => {
    const limited = await FakeDepop.start({
      rateLimits: { other: { requests: 2, windowMs: 60_000 } },
    });
    try {
      const response = await fetch(`${limited.url}/api/v1/oauth2/access-token/`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: limited.grant(limited.developmentSellerId),
          client_id: FAKE_DEPOP_CLIENT_ID,
          client_secret: FAKE_DEPOP_CLIENT_SECRET,
        }).toString(),
      });
      const bearer = ((await response.json()) as { access_token: string }).access_token;
      const get = () =>
        fetch(`${limited.url}/api/v1/products/by-sku/ANY/`, {
          headers: { authorization: `Bearer ${bearer}` },
        });
      expect((await get()).status).toBe(404);
      expect((await get()).status).toBe(404);
      const refused = await get();
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await refused.json()).toMatchObject({
        error: 'TOO_MANY_REQUESTS',
        code: 429,
        detail: expect.stringContaining('user id') as string,
      });
    } finally {
      await limited.close();
    }
  });

  it('rotates refresh tokens, and refuses a token without the scope a call needs', async () => {
    const refreshToken = fake.grant(fake.developmentSellerId, ['products_read']);
    const readOnly = await accessToken(refreshToken);
    const refused = await call('PUT', '/api/v1/products/by-sku/FK-000005-D1/', listing(), readOnly);
    expect([refused.status, errorCode(refused.body)]).toEqual([403, 'insufficient_scope']);
    expect((await call('GET', '/api/v1/shop/', undefined, readOnly)).status).toBe(403);
    expect((await call('GET', '/api/v1/shop/', undefined, 'pat_unknown')).status).toBe(401);
    // The refresh token was used up by the first refresh, so it is refused now.
    const reused = await fetch(`${fake.url}/api/v1/oauth2/access-token/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: FAKE_DEPOP_CLIENT_ID,
        client_secret: FAKE_DEPOP_CLIENT_SECRET,
      }).toString(),
    });
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({
      error: 'invalid_grant',
      message: 'Depop OAuth2 error',
    });
  });

  it('serves the spec, its status, the shop, and its Depop Shipping options', async () => {
    const spec = await fetch(`${fake.url}/api-docs/openapi.yaml`);
    expect(await spec.text()).toContain('title: Seller API');
    expect(await (await fetch(`${fake.url}/status`)).json()).toEqual({ status: 'OK' });
    expect((await call('GET', '/api/v1/shop/')).body).toMatchObject({ country_code: 'US' });
    const providers = await call(
      'GET',
      `/api/v1/shop/seller-addresses/${String(FAKE_DEPOP_ADDRESS_ID)}/shipping-providers/`,
    );
    expect(providers.body).toMatchObject([{ id: 'USPS' }]);
  });
});

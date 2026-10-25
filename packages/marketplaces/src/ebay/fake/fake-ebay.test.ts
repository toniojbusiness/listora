/**
 * The fake eBay's contract, request by request: the documented validation, error codes, and
 * state rules of each call, independent of the adapter (README.md cites the pages).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { TRADING_COMPATIBILITY_LEVEL, type TradingCallName } from '../trading.ts';
import {
  child,
  children,
  el,
  parseXml,
  text,
  toXml,
  TRADING_NAMESPACE,
  type XmlElement,
  type XmlNode,
} from '../xml.ts';
import {
  FAKE_EBAY_CLIENT_ID,
  FAKE_EBAY_CLIENT_SECRET,
  FAKE_EBAY_POLICIES,
  FAKE_EBAY_REFRESH_TOKEN,
} from './constants.ts';
import { FakeEbay } from './fake-ebay.ts';

describe('fake eBay', () => {
  let fake: FakeEbay;
  let token: string;
  let sku = 0;

  beforeAll(async () => {
    fake = await FakeEbay.start();
    token = await userToken(FAKE_EBAY_REFRESH_TOKEN);
  });

  afterAll(async () => {
    await fake.close();
  });

  afterEach(() => {
    fake.clearFaults();
  });

  async function userToken(refreshToken: string): Promise<string> {
    const response = await fetch(`${fake.url}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${FAKE_EBAY_CLIENT_ID}:${FAKE_EBAY_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
    });
    const body = (await response.json()) as { access_token: string; token_type: string };
    expect(body.token_type).toBe('User Access Token');
    return body.access_token;
  }

  async function call(
    callName: TradingCallName,
    fields: (XmlElement | null)[],
    options: { token?: string | null; header?: string } = {},
  ): Promise<{
    ack: string;
    errors: { code: string; message: string; parameters: string[] }[];
    body: XmlNode;
  }> {
    const response = await fetch(`${fake.url}/ws/api.dll`, {
      method: 'POST',
      headers: {
        'content-type': 'text/xml',
        'x-ebay-api-call-name': options.header ?? callName,
        'x-ebay-api-siteid': '0',
        'x-ebay-api-compatibility-level': TRADING_COMPATIBILITY_LEVEL,
        ...(options.token === null ? {} : { 'x-ebay-api-iaf-token': options.token ?? token }),
      },
      body: toXml(el(`${callName}Request`, fields, { xmlns: TRADING_NAMESPACE })),
    });
    expect(response.status).toBe(200);
    const { node } = parseXml(await response.text());
    return {
      ack: text(node, 'Ack') ?? '',
      errors: children(node, 'Errors').map((error) => ({
        code: text(error, 'ErrorCode') ?? '',
        message: text(error, 'LongMessage') ?? '',
        parameters: children(error, 'ErrorParameters').map(
          (parameter) => text(parameter, 'Value') ?? '',
        ),
      })),
      body: node,
    };
  }

  function item(overrides: Record<string, XmlElement | null> = {}): XmlElement {
    sku += 1;
    const fields: Record<string, XmlElement | null> = {
      Title: el('Title', "Levi's Trucker Jacket Men's M"),
      Description: el('Description', 'A jacket.'),
      PrimaryCategory: el('PrimaryCategory', [el('CategoryID', '57988')]),
      StartPrice: el('StartPrice', '45.00', { currencyID: 'USD' }),
      Currency: el('Currency', 'USD'),
      Country: el('Country', 'US'),
      ListingType: el('ListingType', 'FixedPriceItem'),
      ConditionID: el('ConditionID', '3000'),
      PostalCode: el('PostalCode', '95125'),
      PictureDetails: el('PictureDetails', [
        el('PictureURL', 'https://media.listora.test/p/front.jpg'),
      ]),
      ItemSpecifics: el('ItemSpecifics', [
        specific('Brand', "Levi's"),
        specific('Size', 'M'),
        specific('Color', 'Blue'),
        specific('Department', 'Men'),
      ]),
      SellerProfiles: el('SellerProfiles', [
        el('SellerShippingProfile', [el('ShippingProfileID', FAKE_EBAY_POLICIES.shipping)]),
        el('SellerReturnProfile', [el('ReturnProfileID', FAKE_EBAY_POLICIES.return)]),
        el('SellerPaymentProfile', [el('PaymentProfileID', FAKE_EBAY_POLICIES.payment)]),
      ]),
      SKU: el('SKU', `FAKE-SKU-${String(sku)}`),
      InventoryTrackingMethod: el('InventoryTrackingMethod', 'SKU'),
      ...overrides,
    };
    return el('Item', Object.values(fields));
  }

  const specific = (name: string, value: string): XmlElement =>
    el('NameValueList', [el('Name', name), el('Value', value)]);
  const uuid = (n: number): string => n.toString(16).toUpperCase().padStart(32, '0');

  async function add(overrides: Record<string, XmlElement | null> = {}) {
    const result = await call('AddFixedPriceItem', [item(overrides)]);
    expect(result.errors).toEqual([]);
    return text(result.body, 'ItemID') ?? '';
  }

  async function firstError(callName: TradingCallName, fields: (XmlElement | null)[]) {
    const result = await call(callName, fields);
    expect(result.ack).toBe('Failure');
    return result.errors[0];
  }

  it('lists a fixed-price item and reads it back by id and by SKU', async () => {
    const itemId = await add({ SKU: el('SKU', 'FAKE-READ-1') });
    expect(itemId).toMatch(/^\d{12}$/);
    for (const lookup of [el('ItemID', itemId), el('SKU', 'FAKE-READ-1')]) {
      const read = await call('GetItem', [lookup, el('DetailLevel', 'ReturnAll')]);
      const listed = child(read.body, 'Item');
      expect(text(listed, 'ItemID')).toBe(itemId);
      expect(text(child(listed, 'SellingStatus'), 'ListingStatus')).toBe('Active');
      expect(text(child(child(listed, 'SellingStatus'), 'CurrentPrice'), '#text')).toBe('45.0');
      expect(text(listed, 'Description')).toBe('A jacket.');
    }
    const brief = await call('GetItem', [el('ItemID', itemId)]);
    expect(text(child(brief.body, 'Item'), 'Description')).toBeUndefined();
  });

  it("refuses what eBay refuses, with eBay's error codes", async () => {
    const cases: [Record<string, XmlElement | null>, string][] = [
      [{ Title: el('Title', '') }, '69'],
      [{ Title: el('Title', 'x'.repeat(81)) }, '70'],
      [{ Description: null }, '106'],
      [{ PrimaryCategory: el('PrimaryCategory', [el('CategoryID', '1059')]) }, '107'],
      [{ ConditionID: null }, '21916884'],
      [{ ConditionID: el('ConditionID', '7000') }, '21916883'],
      [{ PictureDetails: null }, '21919136'],
      [
        {
          PictureDetails: el('PictureDetails', [
            el('PictureURL', 'http://media.listora.test/p.jpg'),
          ]),
        },
        '37',
      ],
      [
        {
          ItemSpecifics: el('ItemSpecifics', [
            specific('Brand', 'X'),
            specific('Color', 'Blue'),
            specific('Department', 'Men'),
          ]),
        },
        '21919303',
      ],
      [
        {
          ItemSpecifics: el('ItemSpecifics', [
            specific('Brand', 'X'),
            specific('Size', 'Medium'),
            specific('Color', 'Blue'),
            specific('Department', 'Men'),
          ]),
        },
        '21916520',
      ],
      [{ ItemSpecifics: el('ItemSpecifics', [specific('Brand', 'x'.repeat(66))]) }, '21919308'],
      [{ UUID: el('UUID', 'not-a-uuid') }, '487'],
      [
        {
          SellerProfiles: el('SellerProfiles', [
            el('SellerShippingProfile', [el('ShippingProfileID', '1')]),
          ]),
        },
        '21917327',
      ],
      [{ SellerProfiles: null }, '37'],
      [{ ListingType: el('ListingType', 'Chinese') }, '37'],
    ];
    for (const [overrides, code] of cases) {
      const error = await firstError('AddFixedPriceItem', [item(overrides)]);
      expect(error?.code, JSON.stringify(Object.keys(overrides))).toBe(code);
    }
  });

  it('applies a UUID once, and names the listing it created when the UUID comes again', async () => {
    const itemId = await add({ UUID: el('UUID', uuid(1)) });
    const error = await firstError('AddFixedPriceItem', [item({ UUID: el('UUID', uuid(1)) })]);
    expect(error?.code).toBe('488');
    expect(error?.message).toBe(
      `The specified UUID has already been used; isFromSameApplication=true, item ID=${itemId}.`,
    );
    expect(error?.parameters).toEqual(['true', itemId]);
  });

  it('refuses a second active listing with the same tracked SKU', async () => {
    await add({ SKU: el('SKU', 'FAKE-DUP') });
    expect(
      (await firstError('AddFixedPriceItem', [item({ SKU: el('SKU', 'FAKE-DUP') })]))?.code,
    ).toBe('21674');
  });

  it('checks a listing without creating one (VerifyAddFixedPriceItem)', async () => {
    const before = fake.listings().length;
    const verified = await call('VerifyAddFixedPriceItem', [item()]);
    expect(verified.ack).toBe('Success');
    expect(text(verified.body, 'ItemID')).toBe('0');
    expect(fake.listings()).toHaveLength(before);
    expect((await firstError('VerifyAddFixedPriceItem', [item({ Title: null })]))?.code).toBe('69');
  });

  it('revises, ends, and relists by the documented rules', async () => {
    const itemId = await add();
    const revised = await call('ReviseFixedPriceItem', [
      el('Item', [
        el('ItemID', itemId),
        el('InventoryTrackingMethod', 'SKU'),
        el('StartPrice', '39.99', { currencyID: 'USD' }),
      ]),
    ]);
    expect(revised.errors).toEqual([]);
    expect(fake.listing(itemId)).toMatchObject({ price: '39.99', revised: true });

    const end = [el('ItemID', itemId), el('EndingReason', 'NotAvailable')];
    expect((await call('EndFixedPriceItem', end)).errors).toEqual([]);
    expect((await firstError('EndFixedPriceItem', end))?.code).toBe('1047');
    expect(
      (
        await firstError('ReviseFixedPriceItem', [
          el('Item', [
            el('ItemID', itemId),
            el('InventoryTrackingMethod', 'SKU'),
            el('Title', 'New'),
          ]),
        ])
      )?.code,
    ).toBe('291');

    const relist = await call('RelistFixedPriceItem', [
      el('Item', [el('ItemID', itemId), el('UUID', uuid(9))]),
    ]);
    const relistedId = text(relist.body, 'ItemID') ?? '';
    expect(relistedId).not.toBe(itemId);
    expect(fake.listing(itemId)?.relistedItemId).toBe(relistedId);
    expect(fake.listing(relistedId)).toMatchObject({ status: 'Active', price: '39.99' });
    expect(
      (await firstError('RelistFixedPriceItem', [el('Item', [el('ItemID', relistedId)])]))?.code,
    ).toBe('196');
    expect(
      (
        await firstError('RelistFixedPriceItem', [
          el('Item', [el('ItemID', itemId), el('UUID', uuid(9))]),
        ])
      )?.code,
    ).toBe('488');
  });

  it('answers 17 for a listing eBay no longer has, and serves stale reads when asked', async () => {
    const itemId = await add();
    await call('ReviseFixedPriceItem', [
      el('Item', [
        el('ItemID', itemId),
        el('InventoryTrackingMethod', 'SKU'),
        el('StartPrice', '30.00', { currencyID: 'USD' }),
      ]),
    ]);
    fake.inject({ action: 'get_item', fault: { type: 'stale_read' } });
    const stale = await call('GetItem', [el('ItemID', itemId)]);
    expect(text(child(child(stale.body, 'Item'), 'SellingStatus'), 'CurrentPrice')).toBe('45.0');
    fake.remove(itemId);
    expect((await firstError('GetItem', [el('ItemID', itemId)]))?.code).toBe('17');
    expect((await firstError('GetItem', [el('ItemID', 'not-a-number')]))?.code).toBe('37');
  });

  it('shows a sale as a completed listing and an order', async () => {
    const itemId = await add({ SKU: el('SKU', 'FAKE-SOLD') });
    const order = fake.sell(itemId, { buyer: 'buyer_1' });
    const read = await call('GetItem', [el('ItemID', itemId)]);
    const status = child(child(read.body, 'Item'), 'SellingStatus');
    expect(text(status, 'ListingStatus')).toBe('Completed');
    expect(text(status, 'QuantitySold')).toBe('1');

    const response = await fetch(`${fake.url}/sell/fulfillment/v1/order?limit=200`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const page = (await response.json()) as {
      orders: { orderId: string; lineItems: { legacyItemId: string; sku: string }[] }[];
    };
    expect(
      page.orders.find((candidate) => candidate.orderId === order.orderId)?.lineItems,
    ).toMatchObject([{ legacyItemId: itemId, sku: 'FAKE-SOLD' }]);
  });

  it('pages GetSellerList and filters it by SKU, within a range under 120 days', async () => {
    await add({ SKU: el('SKU', 'FAKE-LIST-1') });
    const now = Date.now();
    const range = [
      el('StartTimeFrom', new Date(now - 60_000).toISOString()),
      el('StartTimeTo', new Date(now + 60_000).toISOString()),
    ];
    const page = await call('GetSellerList', [
      ...range,
      el('SKUArray', [el('SKU', 'FAKE-LIST-1')]),
      el('Pagination', [el('EntriesPerPage', 1), el('PageNumber', 1)]),
    ]);
    expect(
      children(child(page.body, 'ItemArray'), 'Item').map((listed) => text(listed, 'SKU')),
    ).toEqual(['FAKE-LIST-1']);
    expect(text(page.body, 'HasMoreItems')).toBe('false');
    const tooLong = [
      el('StartTimeFrom', new Date(now - 121 * 24 * 3_600_000).toISOString()),
      el('StartTimeTo', new Date(now).toISOString()),
      el('Pagination', [el('EntriesPerPage', 10)]),
    ];
    expect((await firstError('GetSellerList', tooLong))?.code).toBe('37');
  });

  it('refuses a missing, invalid, or expired token, and an unknown call', async () => {
    expect((await call('GetItem', [el('ItemID', '1')], { token: null })).errors[0]?.code).toBe(
      '930',
    );
    expect(
      (await call('GetItem', [el('ItemID', '1')], { token: 'nonsense' })).errors[0]?.code,
    ).toBe('21916984');
    const unknown = await call('GetItem', [el('ItemID', '1')], { header: 'GetUser' });
    expect(unknown.errors[0]?.code).toBe('2');
    const expiring = await userToken(FAKE_EBAY_REFRESH_TOKEN);
    fake.expireAccessTokens();
    expect((await call('GetItem', [el('ItemID', '1')], { token: expiring })).errors[0]?.code).toBe(
      '21917053',
    );
    token = await userToken(FAKE_EBAY_REFRESH_TOKEN);
  });

  it('enforces the daily Trading call limit and reports usage like getRateLimits', async () => {
    const limited = await FakeEbay.start({ tradingDailyLimit: 2 });
    try {
      const before = fake.tradingCalls;
      fake.inject({ action: 'get_item', fault: { type: 'call_limit' } });
      expect((await call('GetItem', [el('ItemID', '1')])).errors[0]?.code).toBe('518');
      expect(fake.tradingCalls).toBe(before);

      const response = await fetch(
        `${limited.url}/developer/analytics/v1_beta/rate_limit/?api_context=tradingapi`,
        {
          headers: { authorization: `Bearer ${await applicationToken(limited)}` },
        },
      );
      const usage = (await response.json()) as {
        rateLimits: {
          resources: { rates: { limit: number; remaining: number; timeWindow: number }[] }[];
        }[];
      };
      expect(usage.rateLimits[0]?.resources[0]?.rates[0]).toMatchObject({
        limit: 2,
        remaining: 2,
        timeWindow: 86_400,
      });
    } finally {
      await limited.close();
    }
  });

  it('copies https photos into EPS and refuses http ones, like the Media API', async () => {
    const create = (imageUrl: string) =>
      fetch(`${fake.url}/commerce/media/v1_beta/image/create_image_from_url`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ imageUrl }),
      });
    const created = await create('https://media.listora.test/p/front.jpg');
    expect(created.status).toBe(201);
    expect(created.headers.get('location')).toMatch(/\/commerce\/media\/v1_beta\/image\//);
    const { imageUrl } = (await created.json()) as { imageUrl: string };
    expect(imageUrl).toMatch(/^https:\/\//);
    const refused = await create('http://media.listora.test/p/front.jpg');
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { errors: { errorId: number }[] }).errors[0]?.errorId).toBe(
      190204,
    );
  });

  async function applicationToken(target: FakeEbay): Promise<string> {
    const response = await fetch(`${target.url}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${FAKE_EBAY_CLIENT_ID}:${FAKE_EBAY_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
    });
    return ((await response.json()) as { access_token: string }).access_token;
  }
});

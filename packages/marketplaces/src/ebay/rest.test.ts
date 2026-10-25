/**
 * The REST clients and the Trading client against the fake eBay: order pages, eBay's reported
 * Trading usage, and the daily limit as eBay enforces it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DailyCallBudget } from './budget.ts';
import {
  FAKE_EBAY_CLIENT_ID,
  FAKE_EBAY_CLIENT_SECRET,
  FAKE_EBAY_REFRESH_TOKEN,
} from './fake/constants.ts';
import { FakeEbay } from './fake/fake-ebay.ts';
import { ApplicationToken, EbayOAuthClient } from './oauth.ts';
import { AnalyticsTradingUsage, getOrders, tradingUsage } from './rest.ts';
import { TradingClient } from './trading.ts';
import { el } from './xml.ts';

const signal = new AbortController().signal;

describe('eBay REST and Trading clients against the fake eBay', () => {
  let fake: FakeEbay;
  let oauth: EbayOAuthClient;
  let token: string;

  beforeAll(async () => {
    fake = await FakeEbay.start({ tradingDailyLimit: 3 });
    oauth = new EbayOAuthClient({
      tokenUrl: `${fake.url}/identity/v1/oauth2/token`,
      clientId: FAKE_EBAY_CLIENT_ID,
      clientSecret: FAKE_EBAY_CLIENT_SECRET,
    });
    token = (await oauth.refreshUserToken(FAKE_EBAY_REFRESH_TOKEN, [], signal)).token;
  });

  afterAll(async () => {
    await fake.close();
  });

  const endpoints = () => ({ api: fake.url, media: fake.url });
  const options = () => ({ token, signal, timeoutMs: 1_000 });

  it('pages the seller orders and filters them by last change', async () => {
    const empty = await getOrders(endpoints(), { limit: 1 }, options());
    expect(empty).toEqual({ type: 'ok', value: { orders: [], total: 0, next: null } });

    const since = new Date(Date.now() - 1_000);
    const client = new TradingClient({
      url: `${fake.url}/ws/api.dll`,
      budget: new DailyCallBudget(),
    });
    for (const sku of ['ORDER-1', 'ORDER-2']) {
      const added = await client.call(
        'AddFixedPriceItem',
        [
          el('Item', [
            el('Title', 'Jacket'),
            el('Description', 'A jacket.'),
            el('PrimaryCategory', [el('CategoryID', '52357')]),
            el('StartPrice', '20.00', { currencyID: 'USD' }),
            el('Currency', 'USD'),
            el('Country', 'US'),
            el('ListingType', 'FixedPriceItem'),
            el('ConditionID', '3000'),
            el('PostalCode', '95125'),
            el('DispatchTimeMax', '3'),
            el('ShippingDetails', [el('ShippingType', 'Flat')]),
            el('ReturnPolicy', [el('ReturnsAcceptedOption', 'ReturnsNotAccepted')]),
            el('PictureDetails', [el('PictureURL', 'https://media.listora.test/p.jpg')]),
            el('ItemSpecifics', [
              el('NameValueList', [el('Name', 'Brand'), el('Value', 'Unbranded')]),
            ]),
            el('SKU', sku),
          ]),
        ],
        { token, priority: 'normal', signal },
      );
      if (added.type !== 'response') throw new Error(added.type);
      expect(added.errors).toEqual([]);
      fake.sell(fake.listings(sku)[0]?.itemId ?? '');
    }
    const first = await getOrders(endpoints(), { limit: 1, modifiedSince: since }, options());
    expect(first).toMatchObject({
      type: 'ok',
      value: { total: 2, next: expect.any(String) as string },
    });
    if (first.type !== 'ok' || first.value.next === null) throw new Error('no next page');
    expect(first.value.orders[0]).toMatchObject({
      orderPaymentStatus: 'PAID',
      total: { value: '20.0', currency: 'USD' },
      lineItems: [{ sku: 'ORDER-1', quantity: 1 }],
    });
    const second = await getOrders(endpoints(), { pageUrl: first.value.next }, options());
    expect(second).toMatchObject({
      type: 'ok',
      value: { next: null, orders: [{ lineItems: [{ sku: 'ORDER-2' }] }] },
    });
    const later = await getOrders(
      endpoints(),
      { modifiedSince: new Date(Date.now() + 60_000) },
      options(),
    );
    expect(later).toMatchObject({ type: 'ok', value: { total: 0 } });
  });

  it("reads the application's Trading usage, and eBay refuses calls past the limit", async () => {
    const usage = new AnalyticsTradingUsage(endpoints(), new ApplicationToken(oauth));
    const read = await usage.read(signal);
    expect(read).toMatchObject({ limit: 3, windowMs: 86_400_000 });
    expect(read.remaining).toBe(3 - fake.tradingCalls);

    const client = new TradingClient({
      url: `${fake.url}/ws/api.dll`,
      budget: new DailyCallBudget({ dailyLimit: 100 }),
    });
    for (let call = fake.tradingCalls; call < 3; call += 1) {
      await client.call('GetItem', [el('ItemID', '1')], { token, priority: 'urgent', signal });
    }
    const refused = await client.call('GetItem', [el('ItemID', '1')], {
      token,
      priority: 'urgent',
      signal,
    });
    expect(refused).toMatchObject({ type: 'response', ack: 'Failure', errors: [{ code: '518' }] });
    expect((await usage.read(signal)).remaining).toBe(0);
  });

  it('reports a garbled answer as possibly applied', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/xml' });
      response.end('<?xml version="1.0"?><AddFixedPriceItemResponse><Ack>Succ');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const client = new TradingClient({
      url: `http://127.0.0.1:${String(port)}/ws/api.dll`,
      budget: new DailyCallBudget(),
    });
    expect(
      await client.call('AddFixedPriceItem', [], { token, priority: 'normal', signal }),
    ).toEqual({
      type: 'maybe_sent',
      code: 'connection_lost',
    });
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
});

describe('tradingUsage', () => {
  const rate = (limit: number, remaining: number, timeWindow: number) => ({
    count: limit - remaining,
    limit,
    remaining,
    reset: '2026-10-25T07:00:00.000Z',
    timeWindow,
  });
  const answer = (resources: { name: string; rates: unknown[] }[]) => ({
    rateLimits: [{ apiContext: 'TradingAPI', apiName: 'TradingAPI', resources }],
  });

  it('takes the app-wide daily rate, never a nearly used-up per-call or short-window one', () => {
    const usage = tradingUsage(
      answer([
        { name: 'GetItem', rates: [rate(100, 0, 86_400)] },
        { name: 'TradingAPI', rates: [rate(5_000, 4_200, 86_400), rate(50, 1, 5)] },
        { name: 'AddFixedPriceItem', rates: [rate(10_000, 9_000, 86_400)] },
      ]),
      0,
    );
    expect(usage).toEqual({
      limit: 5_000,
      remaining: 4_200,
      resetAt: Date.parse('2026-10-25T07:00:00.000Z'),
      windowMs: 86_400_000,
    });
  });

  it('falls back to the largest daily rate without the aggregate resource, and to none without a daily one', () => {
    expect(
      tradingUsage(
        answer([
          { name: 'GetItem', rates: [rate(100, 0, 86_400)] },
          { name: 'Other', rates: [rate(5_000, 3_000, 86_400), rate(50, 0, 60)] },
        ]),
        0,
      ),
    ).toMatchObject({ limit: 5_000, remaining: 3_000 });
    expect(tradingUsage(answer([{ name: 'TradingAPI', rates: [rate(50, 0, 5)] }]), 0)).toBe(
      undefined,
    );
  });
});

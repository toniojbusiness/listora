/**
 * The Vinted automation adapter's session check on the fake Vinted site, in a real headless
 * Chromium (Vinted plan M3): it passes on a signed-in session and reads the member it is signed
 * in as, and it stops at Vinted's checks (DataDome, a CAPTCHA, a sign-in code, a signed-out
 * session) without ever passing one. It reads the seller's listings for sale for an import and
 * their sold orders for the sales history (M4), only ever with GETs, and stops at a check there
 * too. The listing steps (M5) are in listing.int.test.ts. No traffic goes to Vinted; the pages
 * and the web API are invented until the mapping (M2) records the real ones.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AdapterContext } from '@listora/marketplaces';

import { automationProfile } from '../profiles.ts';
import { PlaywrightBrowserRunner } from '../runner/browser-runner.ts';
import { MemoryScreenshotStore } from '../runner/screenshots.ts';
import { FakeSiteSessions, QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { createVintedAutomationAdapter } from './adapter.ts';
import {
  FakeVintedSite,
  type FakeVintedAction,
  type FakeVintedFault,
  type FakeVintedItem,
  type FakeVintedOrder,
} from './fake/fake-vinted-site.ts';
import { HISTORY_ORDER_LIMITS } from './scripts.ts';

/** An invented item of the fake seller's. */
const item = (id: string, extra: Partial<FakeVintedItem> = {}): FakeVintedItem => ({
  id,
  title: `Invented item ${id}`,
  description: `An invented description of item ${id}.`,
  priceCents: 1800,
  state: 'active',
  brand: 'Levi’s',
  size: 'W32',
  condition: 'Very good',
  catalogId: 257,
  colors: ['Blue'],
  photos: [`vinted-${id}-a`, `vinted-${id}-b`],
  ...extra,
});

const order = (id: string, extra: Partial<FakeVintedOrder> = {}): FakeVintedOrder => ({
  id,
  paidAt: new Date('2026-10-20T15:00:00.000Z'),
  state: 'completed',
  itemIds: [],
  priceCents: 1800,
  title: `Invented order ${id}`,
  ...extra,
});

const connection = { id: 'connection-vinted', mode: 'automation', status: 'connected' } as const;
const ctx = (): AdapterContext => ({ signal: new AbortController().signal, connection });

describe('Vinted automation adapter on the fake Vinted site', () => {
  let site: FakeVintedSite;
  let runner: PlaywrightBrowserRunner;
  let sessions: FakeSiteSessions;
  let adapter: ReturnType<typeof createVintedAutomationAdapter>;
  /** The login the next session is signed in as. */
  let login = 'Vinted-Test.Shop';

  beforeAll(async () => {
    site = await FakeVintedSite.start(0);
    runner = new PlaywrightBrowserRunner({
      logger: silentLogger,
      screenshots: new MemoryScreenshotStore(),
      stepTimeoutMs: 3_000,
    });
    const profile = { ...automationProfile('vinted'), pacing: QUICK_PACING };
    sessions = new FakeSiteSessions({ issueSession: () => site.issueSession(login) }, runner, {
      ...profile,
      origins: [site.url],
      apiOrigins: [site.url],
      cookieDomains: ['127.0.0.1'],
    });
    adapter = createVintedAutomationAdapter({
      siteUrl: site.url,
      profile,
      sessions,
      photos: stubPhotos,
      logger: silentLogger,
    });
  });

  afterEach(() => {
    site.clearFaults();
    sessions.challenges.length = 0;
    login = 'Vinted-Test.Shop';
    site.items = [];
    site.orders = [];
    site.maxPageSize = 96;
  });

  afterAll(async () => {
    await runner.close();
    await site.close();
  });

  const inject = (fault: FakeVintedFault, action: FakeVintedAction = 'health') => {
    site.injectFault({ action, fault });
  };

  /** Whether every request since `from` only read (a GET). */
  const onlyRead = (from: number) =>
    site.requests.slice(from).every((request) => request.method === 'GET');

  it('passes on a signed-in session and reads the member, lower-cased', async () => {
    expect(await adapter.healthCheck(ctx())).toEqual({
      status: 'ok',
      sellerId: 'vinted-test.shop',
    });
    expect(sessions.requests.at(-1)).toMatchObject({ purpose: 'health' });
  });

  it('reads a login with characters a URL escapes', async () => {
    login = 'shop ñ';
    expect(await adapter.healthCheck(ctx())).toEqual({ status: 'ok', sellerId: 'shop ñ' });
  });

  it('leaves the member unknown when the profile link names no login, never a guess', async () => {
    inject({ type: 'no_login' });
    expect(await adapter.healthCheck(ctx())).toEqual({ status: 'ok' });
  });

  it('cannot check a page that is not as Listora knows it, and keeps the session', async () => {
    inject({ type: 'redesigned' });
    expect(await adapter.healthCheck(ctx())).toMatchObject({
      status: 'degraded',
      code: 'element_missing',
    });
    expect(sessions.challenges).toEqual([]);
  });

  it.each([
    ['DataDome', { type: 'datadome' }, 'captcha'],
    ['a CAPTCHA', { type: 'captcha' }, 'captcha'],
    ['a sign-in code', { type: 'login_challenge' }, 'login_challenge'],
    ['a signed-out session', { type: 'session_expired' }, 'session_rejected'],
  ] satisfies [string, FakeVintedFault, string][])(
    'stops at %s and asks the seller to link again',
    async (_name, fault, challenge) => {
      inject(fault);
      expect(await adapter.healthCheck(ctx())).toMatchObject({
        status: 'reauth_required',
        code: challenge,
      });
      expect(sessions.challenges).toEqual([challenge]);
    },
  );

  it.each([
    ['a rate limit', { type: 'rate_limited', retryAfterSeconds: 60 }, 'rate_limited'],
    ['an error page', { type: 'server_error' }, 'server_error'],
  ] satisfies [string, FakeVintedFault, string][])(
    'cannot check on %s, and keeps the session',
    async (_name, fault, code) => {
      inject(fault);
      expect(await adapter.healthCheck(ctx())).toMatchObject({ status: 'degraded', code });
      expect(sessions.challenges).toEqual([]);
    },
  );

  describe('listings, for an import', () => {
    it('reads the listings for sale with their photos and details, and nothing else', async () => {
      site.items = [
        item('5101', {
          title: 'Levis 501 90s',
          description: 'Faded, no rips.\n\nSKU: AJ-000184',
          priceCents: 2450,
          colors: ['Light blue', 'Khaki'],
        }),
        item('5102', { state: 'hidden' }),
        item('5103', { state: 'sold' }),
        item('5104', { state: 'draft' }),
        item('5105', {
          state: 'reserved',
          brand: 'No brand',
          condition: 'New with tags',
          catalogId: null,
          colors: [],
        }),
      ];
      const from = site.requests.length;
      const page = await adapter.listListings(null, ctx());
      expect(page.next).toBeNull();
      expect(page.listings).toHaveLength(2);
      expect(page.listings[0]).toEqual({
        found: true,
        externalListingId: '5101',
        externalUrl: `${site.url}/items/5101`,
        status: 'active',
        title: 'Levis 501 90s',
        description: 'Faded, no rips.',
        priceCents: 2450,
        currency: 'USD',
        revision: null,
        refreshedAt: null,
        details: {
          photoUrls: [`${site.url}/media/vinted-5101-a.jpg`, `${site.url}/media/vinted-5101-b.jpg`],
          brand: 'Levi’s',
          size: 'W32',
          condition: 'pre_owned_excellent',
          categoryRef: '257',
          categoryPath: [],
          colors: ['blue'],
          originalPriceCents: null,
          sku: 'AJ-000184',
        },
      });
      // Reserved for a buyer is still listed; "No brand" is none.
      expect(page.listings[1]).toMatchObject({
        externalListingId: '5105',
        status: 'active',
        details: { brand: null, condition: 'new_with_tags', categoryRef: null, colors: [] },
      });
      expect(onlyRead(from)).toBe(true);
      expect(sessions.requests.at(-1)).toMatchObject({ purpose: 'import' });
    });

    it('reads its pages in turn, and only the listings Listora does not have on their own', async () => {
      site.maxPageSize = 2;
      site.items = ['6001', '6002', '6003'].map((id) => item(id));
      const from = site.requests.length;
      const first = await adapter.listListings(null, ctx(), ['6002']);
      expect(first.next).toBe('2');
      expect(first.listings.map((one) => [one.externalListingId, one.fromList ?? false])).toEqual([
        ['6001', false],
        ['6002', true],
      ]);
      // The one Listora has is taken from the wardrobe as it shows it: no item read.
      const reads = site.requests.slice(from).map((request) => request.path);
      expect(reads).toContain('/api/v2/items/6001');
      expect(reads).not.toContain('/api/v2/items/6002');
      const second = await adapter.listListings('2', ctx());
      expect(second).toMatchObject({ next: null, listings: [{ externalListingId: '6003' }] });
    });

    it('reads only the wardrobe of the member signed in', async () => {
      site.items = [item('6101')];
      await adapter.listListings(null, ctx());
      const wardrobe = site.requests.filter((request) => request.path.includes('/wardrobe/'));
      expect(wardrobe.at(-1)?.path).toMatch(/^\/api\/v2\/wardrobe\/\d+\/items$/);
      expect(wardrobe.at(-1)?.status).toBe(200);
    });

    it('stops at DataDome on the web API, and asks the seller to complete it', async () => {
      site.items = [item('6201')];
      inject({ type: 'datadome_api' }, 'listings');
      await expect(adapter.listListings(null, ctx())).rejects.toMatchObject({ code: 'captcha' });
      expect(sessions.challenges).toEqual(['captcha']);
    });

    it('cannot read an answer it does not know, and keeps the session', async () => {
      site.items = [item('6301')];
      inject({ type: 'unknown_shape' }, 'listings');
      await expect(adapter.listListings(null, ctx())).rejects.toMatchObject({
        code: 'element_missing',
      });
      expect(sessions.challenges).toEqual([]);
    });

    it('stops at a rate limit without reading on', async () => {
      inject({ type: 'rate_limited', retryAfterSeconds: 60 }, 'listings');
      await expect(adapter.listListings(null, ctx())).rejects.toMatchObject({
        code: 'rate_limited',
      });
    });
  });

  describe('sold orders, for the sales history', () => {
    it('reads every sale in progress and completed, and no canceled one in the history, with its items', async () => {
      site.items = [
        item('7001', { state: 'sold', title: 'Invented jacket', priceCents: 3000 }),
        item('7002', { state: 'sold', title: 'Invented tee', priceCents: 1200 }),
        item('7003', { state: 'sold', title: 'Invented scarf', priceCents: 900 }),
        item('7004', { state: 'sold' }),
      ];
      site.orders = [
        order('9001', {
          state: 'in_progress',
          paidAt: new Date('2026-10-30T10:00:00.000Z'),
          itemIds: ['7001'],
          priceCents: 2800,
        }),
        // A bundle: one order, two items, each at its own price.
        order('9002', {
          paidAt: new Date('2026-10-25T10:00:00.000Z'),
          itemIds: ['7002', '7003'],
          priceCents: 1900,
        }),
        order('9003', { state: 'canceled', itemIds: ['7004'] }),
      ];
      const from = site.requests.length;
      const orders = await adapter.listOrdersSince(null, ctx());
      expect(
        orders.map((one) => [one.externalOrderId, one.soldAt.toISOString(), one.shipped]),
      ).toEqual([
        // Paid and waiting to be sent ("Payment successful"); a completed one shipped.
        ['9001', '2026-10-30T10:00:00.000Z', false],
        ['9002', '2026-10-25T10:00:00.000Z', true],
      ]);
      // One item at what the buyer paid for it; a bundle's items at their own prices.
      expect(orders[0]?.items).toMatchObject([
        {
          externalListingId: '7001',
          title: 'Invented jacket',
          priceCents: 2800,
          currency: 'USD',
          listing: {
            status: 'sold',
            details: {
              photoUrls: [
                `${site.url}/media/vinted-7001-a.jpg`,
                `${site.url}/media/vinted-7001-b.jpg`,
              ],
            },
          },
        },
      ]);
      expect(orders[1]?.items.map((one) => [one.externalListingId, one.priceCents])).toEqual([
        ['7002', 1200],
        ['7003', 900],
      ]);
      expect(site.requests.some((request) => request.path === '/api/v2/transactions/9003')).toBe(
        false,
      );
      expect(onlyRead(from)).toBe(true);
      expect(sessions.requests.at(-1)).toMatchObject({ purpose: 'sale_check' });
    });

    it('reads only the orders paid for since the last check', async () => {
      site.items = [item('7101', { state: 'sold' }), item('7102', { state: 'sold' })];
      site.orders = [
        order('9101', { paidAt: new Date('2026-11-02T10:00:00.000Z'), itemIds: ['7101'] }),
        order('9102', { paidAt: new Date('2026-10-01T10:00:00.000Z'), itemIds: ['7102'] }),
      ];
      const orders = await adapter.listOrdersSince(new Date('2026-11-01T00:00:00.000Z'), ctx());
      expect(orders.map((one) => one.externalOrderId)).toEqual(['9101']);
      expect(site.requests.some((request) => request.path === '/api/v2/transactions/9102')).toBe(
        false,
      );
    });

    it('tells where each order in progress stands: to send, sent, delivered, or words it does not know', async () => {
      site.items = ['7301', '7302', '7303', '7304'].map((id) => item(id, { state: 'sold' }));
      const paidAt = new Date('2026-11-03T10:00:00.000Z');
      site.orders = [
        order('9301', { state: 'in_progress', progress: 'to_ship', itemIds: ['7301'], paidAt }),
        order('9302', { state: 'in_progress', progress: 'shipped', itemIds: ['7302'], paidAt }),
        order('9303', { state: 'in_progress', progress: 'delivered', itemIds: ['7303'], paidAt }),
        order('9304', {
          state: 'in_progress',
          statusText: 'Something new on Vinted',
          itemIds: ['7304'],
          paidAt,
        }),
      ];
      const orders = await adapter.listOrdersSince(new Date('2026-11-01T00:00:00.000Z'), ctx());
      expect(orders.map((one) => [one.externalOrderId, one.shipped, one.canceled])).toEqual([
        ['9301', false, undefined],
        ['9302', true, undefined],
        ['9303', true, undefined],
        ['9304', undefined, undefined],
      ]);
    });

    it('reads no sale of an accepted offer the buyer has not paid for, nor its items', async () => {
      site.items = [item('7401', { state: 'active' })];
      site.orders = [
        order('9401', {
          state: 'in_progress',
          progress: 'unpaid',
          itemIds: ['7401'],
          paidAt: new Date('2026-11-03T10:00:00.000Z'),
        }),
      ];
      expect(await adapter.listOrdersSince(null, ctx())).toEqual([]);
      expect(site.requests.some((request) => request.path === '/api/v2/transactions/9401')).toBe(
        false,
      );
    });

    it('reports the orders Vinted canceled or refunded after payment, with no items and no reads of their own', async () => {
      site.items = [item('7501', { state: 'sold' }), item('7502', { state: 'active' })];
      site.orders = [
        // Refunded while in progress, in Vinted's words.
        order('9501', {
          state: 'in_progress',
          statusText: 'Refunded to the buyer',
          itemIds: ['7501'],
          paidAt: new Date('2026-11-02T10:00:00.000Z'),
        }),
        // On the Canceled tab: paid three weeks before the check's since, within its lookback.
        order('9502', {
          state: 'canceled',
          itemIds: ['7502'],
          paidAt: new Date('2026-10-10T10:00:00.000Z'),
        }),
        // Paid too long before: the check stops there.
        order('9503', {
          state: 'canceled',
          itemIds: ['7502'],
          paidAt: new Date('2026-08-01T10:00:00.000Z'),
        }),
      ];
      const from = site.requests.length;
      const orders = await adapter.listOrdersSince(new Date('2026-11-01T00:00:00.000Z'), ctx());
      expect(orders).toEqual([
        {
          externalOrderId: '9501',
          soldAt: new Date('2026-11-02T10:00:00.000Z'),
          canceled: true,
          items: [],
        },
        {
          externalOrderId: '9502',
          soldAt: new Date('2026-10-10T10:00:00.000Z'),
          canceled: true,
          items: [],
        },
      ]);
      expect(
        site.requests
          .slice(from)
          .filter((request) => request.path.startsWith('/api/v2/transactions')),
      ).toEqual([]);
      expect(onlyRead(from)).toBe(true);
      // The sales history reads no canceled order: a canceled order is no sale.
      const history = await adapter.listOrdersSince(null, ctx());
      expect(history.map((one) => one.externalOrderId)).toEqual(['9501']);
    });

    it('reads the history across pages, up to its limit', async () => {
      site.maxPageSize = 2;
      site.orders = ['9201', '9202', '9203'].map((id) => order(id, { title: `Order ${id}` }));
      const orders = await adapter.listOrdersSince(null, ctx());
      // An order whose read shows no item keeps its own title and price, with no listing.
      expect(orders.map((one) => one.items)).toEqual(
        ['9201', '9202', '9203'].map((id) => [
          { externalListingId: null, title: `Order ${id}`, priceCents: 1800, currency: 'USD' },
        ]),
      );
      expect(HISTORY_ORDER_LIMITS.reads).toBeGreaterThanOrEqual(100);
    });

    it('stops when Vinted asks the member to verify their account first, for the seller to do', async () => {
      inject({ type: 'verification_required' }, 'orders');
      await expect(adapter.listOrdersSince(null, ctx())).rejects.toMatchObject({
        code: 'login_challenge',
      });
      expect(sessions.challenges).toEqual(['login_challenge']);
    });

    it('stops at DataDome on the web API, and reports no sales', async () => {
      inject({ type: 'datadome_api' }, 'orders');
      await expect(adapter.listOrdersSince(null, ctx())).rejects.toMatchObject({ code: 'captcha' });
      expect(sessions.challenges).toEqual(['captcha']);
    });

    it('cannot read the orders after a signed-out answer, and says so rather than reporting none', async () => {
      inject({ type: 'session_expired' }, 'orders');
      await expect(adapter.listOrdersSince(null, ctx())).rejects.toMatchObject({
        code: 'element_missing',
      });
    });
  });

  describe('shipping labels, for Pack check (M8)', () => {
    /** A USPS label, invented. */
    const USPS = '9400111899223197428490';
    const request = (id: string, soldAt = '2026-11-05T15:00:00.000Z') => ({
      externalOrderId: id,
      externalListingIds: [],
      soldAt,
    });

    it("reads each order's carrier, label, and ship-by date, with GETs only", async () => {
      site.orders = [
        order('51', {
          state: 'in_progress',
          shipment: {
            id: 801,
            status: 'label_sent',
            carrier: { name: 'USPS' },
            tracking_code: USPS,
            label_type: 'label',
            label_url: `${site.url}/shipments/801/label.pdf`,
            shipping_deadline: '2026-11-12T15:00:00.000Z',
          },
        }),
      ];
      const from = site.requests.length;
      const labels = await adapter.readOrderLabels([request('51')], ctx());
      expect(labels).toEqual([
        {
          externalOrderId: '51',
          found: true,
          trackingNumber: USPS,
          buyerFirstName: null,
          orderState: 'to_ship',
          carrierName: 'USPS',
          shipBy: new Date('2026-11-12T15:00:00.000Z'),
          labelExpiresAt: null,
          labelFormat: 'label',
          labelFileUrl: `${site.url}/shipments/801/label.pdf`,
        },
      ]);
      expect(onlyRead(from)).toBe(true);
    });

    it('reads a QR code shown at the counter, with no file to print, and 5 business days to ship', async () => {
      site.orders = [
        order('52', {
          state: 'in_progress',
          shipment: {
            carrier_name: 'SpeedX',
            tracking_code: 'SPXUS0012345678',
            label_type: 'qr_code',
            label_url: `${site.url}/shipments/802/qr.png`,
          },
        }),
      ];
      // Paid on a Thursday: the fifth business day is the next Thursday.
      const [label] = await adapter.readOrderLabels(
        [request('52', '2026-11-05T15:00:00.000Z')],
        ctx(),
      );
      expect(label).toMatchObject({
        found: true,
        carrierName: 'SpeedX',
        trackingNumber: 'SPXUS0012345678',
        labelFormat: 'qr_code',
        labelFileUrl: null,
        shipBy: new Date('2026-11-12T15:00:00.000Z'),
      });
    });

    it('reads an order with no label yet, shipped and canceled orders, and one Vinted no longer has', async () => {
      site.orders = [
        order('53', { state: 'in_progress', shipment: { status: 'pending' } }),
        order('54', { state: 'completed', shipment: { tracking_code: USPS, status: 'delivered' } }),
        order('55', { state: 'canceled', shipment: { tracking_code: USPS } }),
      ];
      const labels = await adapter.readOrderLabels(
        [request('53'), request('54'), request('55'), request('56'), request('listing:9')],
        ctx(),
      );
      expect(
        labels.map((one) => (one.found ? [one.trackingNumber, one.orderState] : null)),
      ).toEqual([[null, 'to_ship'], [USPS, 'shipped'], [USPS, 'canceled'], null, null]);
    });

    it('never takes a label file from another host', async () => {
      site.orders = [
        order('57', {
          state: 'in_progress',
          shipment: { tracking_code: USPS, label_url: 'https://files.example.com/label.pdf' },
        }),
      ];
      const [label] = await adapter.readOrderLabels([request('57')], ctx());
      expect(label).toMatchObject({ found: true, labelFileUrl: null, labelFormat: null });
    });

    it('stops at DataDome on the web API, and reads no label', async () => {
      site.orders = [order('58', { state: 'in_progress' })];
      inject({ type: 'datadome_api' }, 'orders');
      await expect(adapter.readOrderLabels([request('58')], ctx())).rejects.toMatchObject({
        code: 'captcha',
      });
      expect(sessions.challenges).toEqual(['captcha']);
    });
  });
});

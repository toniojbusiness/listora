/**
 * Mercari's comparison reads on the phone's page backend (comps/run.ts), in headless Chromium
 * standing in for the app's comparison web view, against a local stand-in of Mercari's public
 * search: the sold and for-sale searches matched and counted (the brand Mercari names or the
 * name's words, the type in the name, the model and the size; carousels, lots, and cards of the
 * other kind never counted), the sale days and the search's count from the page's own data, the
 * recent pace, the warm-up, and every way a read stops. There is no recording of the real search
 * yet (Mercari showed the recorder a bot check; docs/features/thrift-scan.md, "Mercari"), so the
 * stand-in follows Listora's model of it (mercari/pages/search-page.ts): its product card as
 * recorded on a real listing page, the page data as recorded there.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Browser, BrowserContext } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PlaywrightPhoneHost } from '../phone/test-host.ts';
import { loadChromium } from '../runner/playwright.ts';
import { QUICK_PACING } from '../test-support.ts';
import { soldLately } from './mercari.ts';
import { runComparison, warmUpComparisons } from './run.ts';
import { COMPARISON_VERSION, type ComparisonInput } from './types.ts';

const NOW = '2026-11-02T12:00:00Z';
const DAY_S = 24 * 60 * 60;
/** Seconds since 1970, `days` before NOW, as Mercari's data has them. */
const ago = (days: number) => Math.round(Date.parse(NOW) / 1000 - days * DAY_S);

interface Invented {
  readonly id: string;
  readonly name: string;
  readonly price: string;
  readonly brand?: string;
  readonly size?: string;
  readonly onSale: boolean;
  /** Days before NOW it sold (a sold one), in the page's data. */
  readonly soldDaysAgo?: number;
}

/** One invented result as Mercari's product card shows it. */
function card(item: Invented): string {
  const brand = item.brand === undefined ? '' : ` data-brand="${item.brand}"`;
  const size = item.size === undefined ? '' : ` data-size="${item.size}"`;
  return `<div class="ItemFeed__ItemBox"><a data-testid="ProductThumbWrapper" href="/us/item/${item.id}/">
    <div data-testid="ItemContainer" data-productid="${item.id}" data-is-liked="false"
      data-is-on-sale="${String(item.onSale)}"${brand}${size}>
      <div data-testid="StyledProductThumb"><img alt="${item.name}" src="data:,"></div>
      <p data-testid="ItemName">${item.name}</p>
      <p data-testid="ProductThumbItemPrice">${item.price}</p>
    </div></a></div>`;
}

/** The page's own data: its Apollo cache, each item and the search's count. */
function nextData(items: readonly Invented[], count: number): string {
  const state: Record<string, unknown> = {
    ROOT_QUERY: {
      __typename: 'Query',
      'search({"criteria":{"query":"levis 501 jeans"}})': { __typename: 'Search', count },
    },
  };
  for (const item of items) {
    state[`SearchItem:${item.id}`] = {
      __typename: 'SearchItem',
      id: item.id,
      status: item.onSale ? 'on_sale' : 'sold_out',
      updated: ago(item.soldDaysAgo ?? 1),
      ...(item.soldDaysAgo === undefined ? {} : { lastSoldAt: ago(item.soldDaysAgo) }),
    };
  }
  return JSON.stringify({ props: { pageProps: { serverState: state } }, page: '/search' });
}

/** The results page: the search's cards, a carousel of other items, and the page's data. */
function searchPage(items: readonly Invented[], count: number, withData = true): string {
  const carousel = card({
    id: 'm99999999999',
    name: "Levi's 501 jeans 32 rare",
    price: '$400.00',
    brand: "Levi's",
    size: '32',
    onSale: false,
    soldDaysAgo: 1,
  });
  const data = withData
    ? `<script id="__NEXT_DATA__" type="application/json">${nextData(items, count)}</script>
       <script>window.__NEXT_DATA__ = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);</script>`
    : '';
  return `<!doctype html><title>levis 501 jeans | Mercari</title>
    <main><div data-testid="Search">${items.map(card).join('')}</div>
    <section><h2>Similar items</h2><div data-testid="FeedContainer">${carousel}</div></section></main>
    ${data}`;
}

const SOLD: Invented[] = [
  {
    id: 'm10000000001',
    name: "Levi's 501 jeans 32x30",
    price: '$28.00',
    brand: "Levi's",
    size: '32',
    onSale: false,
    soldDaysAgo: 2,
  },
  {
    id: 'm10000000002',
    name: 'Levis 501 original fit jeans',
    price: '$32.00$45.00',
    brand: "Levi's",
    size: '32',
    onSale: false,
    soldDaysAgo: 5,
  },
  {
    id: 'm10000000003',
    name: "Levi's 501 button fly jeans",
    price: '$25.00',
    brand: "Levi's",
    size: '32',
    onSale: false,
    soldDaysAgo: 9,
  },
  {
    id: 'm10000000004',
    name: 'Vintage 501 jeans USA',
    price: '$30.00',
    brand: "Levi's",
    size: '32',
    onSale: false,
    soldDaysAgo: 14,
  },
  // No brand set: its name names the brand.
  {
    id: 'm10000000005',
    name: "Levi's 501 jeans black 32",
    price: '$27.00',
    size: '32',
    onSale: false,
    soldDaysAgo: 20,
  },
  {
    id: 'm10000000006',
    name: "Levi's 501 jeans",
    price: '$29.00',
    brand: "Levi's",
    size: '34',
    onSale: false,
    soldDaysAgo: 45,
  },
  {
    id: 'm10000000007',
    name: "Lot of 3 Levi's 501 jeans",
    price: '$60.00',
    brand: "Levi's",
    size: '32',
    onSale: false,
    soldDaysAgo: 3,
  },
  {
    id: 'm10000000008',
    name: "Levi's trucker jacket",
    price: '$40.00',
    brand: "Levi's",
    size: 'M',
    onSale: false,
    soldDaysAgo: 60,
  },
  // An item on sale shown among the sold results: not a sale.
  {
    id: 'm10000000009',
    name: "Levi's 501 jeans",
    price: '$35.00',
    brand: "Levi's",
    size: '32',
    onSale: true,
  },
];

const FOR_SALE: Invented[] = [
  {
    id: 'm20000000001',
    name: "Levi's 501 jeans light wash",
    price: '$35.00',
    brand: "Levi's",
    size: '32',
    onSale: true,
  },
  {
    id: 'm20000000002',
    name: 'Levis 501 jeans 32 x 30',
    price: '$29.00',
    brand: "Levi's",
    size: '32',
    onSale: true,
  },
  {
    id: 'm20000000003',
    name: "Levi's 550 relaxed jeans",
    price: '$22.00',
    brand: "Levi's",
    size: '32',
    onSale: true,
  },
  {
    id: 'm20000000004',
    name: 'Wrangler 501 style jeans',
    price: '$18.00',
    brand: 'Wrangler',
    size: '32',
    onSale: true,
  },
];

describe("Mercari's comparison reads", () => {
  let browser: Browser;
  let context: BrowserContext;
  let server: Server;
  let siteUrl: string;
  /** What the stand-in shows: the sold and for-sale search pages, and its home page. */
  let pages = { sold: searchPage(SOLD, 18_400), forSale: searchPage(FOR_SALE, 1_412) };
  const home = '<!doctype html><title>Mercari: Your Marketplace</title><main>Mercari</main>';
  const requested: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/search/') {
        requested.push(url.search);
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(url.searchParams.get('itemStatuses') === '2' ? pages.sold : pages.forSale);
        return;
      }
      if (url.pathname === '/login/') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          '<!doctype html><title>Log in | Mercari</title><form><input type="password"></form>',
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(home);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    siteUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    browser = await (await loadChromium()).launch();
    context = await browser.newContext();
  });

  afterAll(async () => {
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  function input(): ComparisonInput {
    return {
      version: COMPARISON_VERSION,
      marketplace: 'mercari',
      query: {
        words: 'levis 501 jeans',
        brand: "Levi's",
        model: '501',
        sizeLabel: '32',
        productTypes: [],
        typeWords: ['jeans', 'denim'],
      },
      pacing: QUICK_PACING,
      stepTimeoutMs: 3_000,
      callTimeoutMs: 15_000,
      now: NOW,
    };
  }

  async function compare() {
    const host = new PlaywrightPhoneHost(await context.newPage());
    try {
      return await runComparison(input(), host, {
        siteUrl,
        pacing: { random: () => 0, sleep: () => Promise.resolve() },
      });
    } finally {
      await host.page.close();
    }
  }

  async function withPages<T>(next: typeof pages, run: () => Promise<T>): Promise<T> {
    const before = pages;
    pages = next;
    try {
      return await run();
    } finally {
      pages = before;
    }
  }

  it("reads the sold and for-sale searches and counts only the item's close matches", async () => {
    requested.length = 0;
    const output = await compare();
    expect(output).toEqual({
      outcome: 'read',
      stats: {
        level: 'model_and_size',
        // The five sold 501s in a 32, the brandless one by its name's words; the 34, the lot,
        // the jacket, the carousel's $400 pair, and the one on sale are never among them. The
        // oldest of the five sold 20 days before.
        sold: { count: 5, lowCents: 2700, medianCents: 2800, highCents: 3000, windowDays: 20 },
        forSale: { count: 2, lowCents: 3050, medianCents: 3200, highCents: 3350 },
        read: { sold: 7, forSale: 4 },
      },
      forSaleTotal: 1_412,
      // Of the 7 sold read, 5 sold in the last 30 days (the 34 sold 45 days before, the jacket 60).
      soldTotal: 5,
      ms: expect.any(Number) as number,
    });
    // Only the pages Mercari's own filters and sort make: sold, newest first; then on sale.
    expect(requested).toEqual([
      '?keyword=levis+501+jeans&itemStatuses=2&sortBy=2',
      '?keyword=levis+501+jeans&itemStatuses=1',
    ]);
  });

  it('reads a page without its data: no sale days, no count, no pace', async () => {
    const output = await withPages(
      { sold: searchPage(SOLD, 0, false), forSale: searchPage(FOR_SALE, 0, false) },
      compare,
    );
    expect(output).toMatchObject({
      outcome: 'read',
      stats: { sold: { count: 5 } },
      forSaleTotal: null,
      soldTotal: null,
    });
    // Undated, the sold prices go without a window (the API takes no null for one).
    expect(output.outcome === 'read' && 'windowDays' in (output.stats.sold ?? {})).toBe(false);
  });

  it('reads a search with no results as none', async () => {
    const empty =
      '<!doctype html><title>Mercari</title><main><p data-testid="SearchResultsEmpty">No results</p></main>';
    expect(await withPages({ sold: empty, forSale: pages.forSale }, compare)).toMatchObject({
      outcome: 'read',
      stats: { read: { sold: 0, forSale: 4 } },
      soldTotal: null,
    });
  });

  it('warms up by opening the home page', async () => {
    const host = new PlaywrightPhoneHost(await context.newPage());
    try {
      const warm = await warmUpComparisons({ marketplace: 'mercari' }, host, {
        siteUrl,
        pacing: { random: () => 0, sleep: () => Promise.resolve() },
      });
      expect(warm.outcome).toBe('warm');
      expect(host.page.url()).toBe(`${siteUrl}/`);
    } finally {
      await host.page.close();
    }
  });

  it("stops at Cloudflare's check and never passes it", async () => {
    const check =
      '<!doctype html><title>Just a moment...</title><p>Verifying you are human. This may take a few seconds.</p>';
    expect(await withPages({ sold: check, forSale: pages.forSale }, compare)).toMatchObject({
      outcome: 'check',
    });
  });

  it('stops at a sign-in page and never signs in', async () => {
    const redirect = `<!doctype html><title>Mercari</title><script>location.replace('/login/')</script>`;
    expect(await withPages({ sold: redirect, forSale: pages.forSale }, compare)).toMatchObject({
      outcome: 'check',
    });
  });

  it('fails a results page Listora does not know, without throwing', async () => {
    const unknown = '<!doctype html><title>Mercari</title><main>Something new</main>';
    expect(await withPages({ sold: unknown, forSale: '' }, compare)).toMatchObject({
      outcome: 'failed',
    });
  });

  it('counts as lately only the sold listings dated within 30 days', () => {
    const now = new Date(NOW);
    const at = (days: number) => new Date(now.getTime() - days * DAY_S * 1000);
    expect(
      soldLately(
        [
          { sold: true, at: at(1) },
          { sold: true, at: at(29.9) },
          { sold: true, at: at(31) },
          { sold: true, at: null },
          { sold: false, at: at(1) },
        ],
        now,
      ),
    ).toBe(2);
    expect(soldLately([{ sold: true, at: null }], now)).toBeNull();
    expect(soldLately([], now)).toBeNull();
  });
});

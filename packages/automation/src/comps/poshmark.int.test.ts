/**
 * Poshmark's comparison reads on the phone's page backend (comps/run.ts), in headless Chromium
 * standing in for the app's comparison web view, against a local stand-in of Poshmark's public
 * search, whose pages embed their data as Poshmark's do (an inline `window.__INITIAL_STATE__`
 * that removes its script once it ran, read 2026-11-02): the sold and for-sale searches matched
 * and counted (the brand and Poshmark's department and category, then the model in the title and
 * the size), sales older than the sold window, lots, and many-size listings never counted, the
 * warm-up, and every way a read stops. The results are invented; no real seller's listing is in
 * them. The parser also runs on the recorded real search (poshmark/recordings/search.json).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Browser, BrowserContext } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PlaywrightPhoneHost } from '../phone/test-host.ts';
import { loadChromium } from '../runner/playwright.ts';
import { QUICK_PACING } from '../test-support.ts';
import { runComparison, warmUpComparisons } from './run.ts';
import { COMPARISON_VERSION, type ComparisonInput } from './types.ts';

/** One invented result, as Poshmark's search pages embed it. */
function listing(
  title: string,
  price: string,
  inventory: { status: string; at?: string; multi?: boolean },
  options: { brand?: string; size?: string; department?: string; category?: string } = {},
) {
  const size = options.size ?? '28';
  return {
    id: '6a0000000000000000000001',
    title,
    brand: options.brand ?? "Levi's",
    price_amount: { val: price, currency_code: 'USD', currency_symbol: '$' },
    size,
    inventory: {
      status: inventory.status,
      status_changed_at: inventory.at ?? '2026-09-01T10:00:00-07:00',
      multi_item: inventory.multi ?? false,
      size_quantities: [{ size_id: size, size_obj: { id: size, display: size } }],
    },
    department: { display: options.department ?? 'Women' },
    category_v2: { display: options.category ?? 'Jeans' },
    creator_username: 'invented_seller',
    cover_shot: { url: 'https://example.invalid/photo.jpg' },
  };
}

const sold = (title: string, price: string, at: string, options = {}) =>
  listing(title, price, { status: 'sold_out', at }, options);
const forSale = (title: string, price: string, options = {}) =>
  listing(title, price, { status: 'available' }, options);

const SOLD = [
  sold("Levi's 501 Jeans Size 28", '30.0', '2026-10-30T09:00:00-07:00'),
  sold('Levis 501 high rise jeans', '25.0', '2026-10-25T09:00:00-07:00'),
  sold("Vintage Levi's 501", '35.0', '2026-10-20T09:00:00-07:00'),
  sold("Levi's 501 Original Jeans W28", '28.0', '2026-10-12T09:00:00-07:00'),
  sold("Levi's 501 Jeans light wash", '32.0', '2026-10-03T10:00:00-07:00'),
  // Sold more than 90 days before: an old price, never counted.
  sold("Levi's 501 Jeans", '90.0', '2025-06-01T10:00:00-07:00'),
  sold("Lot of 2 Levi's 501 Jeans", '40.0', '2026-10-28T10:00:00-07:00'),
  sold("Levi's 505 Straight Jeans", '20.0', '2026-10-27T10:00:00-07:00'),
  sold("Levi's Trucker Jacket", '45.0', '2026-10-26T10:00:00-07:00', {
    category: 'Jackets & Coats',
  }),
  sold('Wrangler 501 style jeans', '15.0', '2026-10-24T10:00:00-07:00', { brand: 'Wrangler' }),
];

const FOR_SALE = [
  forSale("Levi's 501 Jeans 28", '34.0'),
  listing("Levi's 501 jeans", '45.0', { status: 'reserved' }),
  forSale("Levi's 501 Jeans", '30.0', { size: '26' }),
  listing("Levi's 501 Jeans all sizes", '60.0', { status: 'available', multi: true }),
  forSale("Men's Levi's 501 Jeans", '40.0', { department: 'Men' }),
];

/** A search page as Poshmark serves it: its data in a script that removes itself. */
function searchPage(results: readonly unknown[], total: number | null): string {
  const state = {
    auth: { isUserLoggedIn: false, identity: null },
    $_search: { gridData: { data: results, total_listing_count: total, facets: {} } },
  };
  const json = JSON.stringify(state).replaceAll('<', '\\u003c');
  return `<!doctype html><title>levis 501 jeans on Poshmark</title>
    <script>window.__INITIAL_STATE__=${json};document.currentScript.remove()</script>
    <main><h1>levis 501 jeans</h1></main>`;
}

describe("Poshmark's comparison reads", () => {
  let browser: Browser;
  let context: BrowserContext;
  let server: Server;
  let siteUrl: string;
  /** What the stand-in shows: the sold and for-sale search pages, and its home page. */
  let pages = { sold: searchPage(SOLD, 264_413), forSale: searchPage(FOR_SALE, 97_581) };
  const home = '<!doctype html><title>Poshmark: Buy and Sell Fashion</title><main>Poshmark</main>';
  const requested: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      response.writeHead(200, { 'content-type': 'text/html' });
      if (url.pathname === '/search') {
        requested.push(url.search);
        response.end(
          url.searchParams.get('availability') === 'sold_out' ? pages.sold : pages.forSale,
        );
        return;
      }
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
      marketplace: 'poshmark',
      query: {
        words: 'levis 501 jeans',
        brand: "Levi's",
        model: '501',
        sizeLabel: '28',
        productTypes: ['Women/Jeans'],
        typeWords: ['jeans'],
      },
      pacing: QUICK_PACING,
      stepTimeoutMs: 5_000,
      callTimeoutMs: 15_000,
      now: '2026-11-02T12:00:00Z',
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

  it("reads the sold and for-sale searches and counts only the item's close matches", async () => {
    requested.length = 0;
    const output = await compare();
    expect(output).toEqual({
      outcome: 'read',
      stats: {
        level: 'model_and_size',
        // The five 501s in 28 that sold in the last 90 days, the oldest 30 days before; the
        // old sale and the lot are never read, and the 505, the jacket, and the Wrangler pair
        // never match.
        sold: { count: 5, lowCents: 2800, medianCents: 3000, highCents: 3200, windowDays: 30 },
        // The 501s in 28 for sale (one reserved for a buyer checking out); the size 26 and the
        // men's pair are other items, and the many-size listing is never read.
        forSale: { count: 2, lowCents: 3675, medianCents: 3950, highCents: 4225 },
        read: { sold: 8, forSale: 4 },
      },
      forSaleTotal: 97_581,
      ms: expect.any(Number) as number,
    });
    // Only the pages the search box and its sold filter make: sold, then for sale.
    expect(requested).toEqual([
      '?query=levis+501+jeans&type=listings&src=dir&availability=sold_out',
      '?query=levis+501+jeans&type=listings&src=dir',
    ]);
  });

  it('reads a search with no results as none', async () => {
    const before = pages;
    pages = { sold: searchPage([], 0), forSale: before.forSale };
    try {
      expect(await compare()).toMatchObject({
        outcome: 'read',
        stats: { level: 'model_and_size', read: { sold: 0, forSale: 4 } },
      });
    } finally {
      pages = before;
    }
  });

  it('warms up by opening the home page', async () => {
    const host = new PlaywrightPhoneHost(await context.newPage());
    try {
      const warm = await warmUpComparisons({ marketplace: 'poshmark' }, host, {
        siteUrl,
        pacing: { random: () => 0, sleep: () => Promise.resolve() },
      });
      expect(warm.outcome).toBe('warm');
      expect(host.page.url()).toBe(`${siteUrl}/`);
    } finally {
      await host.page.close();
    }
  });

  it('stops at a bot check or a CAPTCHA and never passes it', async () => {
    const before = pages;
    for (const shown of [
      '<!doctype html><title>Access Denied</title><p>Please verify you are a human</p>',
      '<!doctype html><title>Poshmark</title><div class="g-recaptcha">I am not a robot</div>',
    ]) {
      pages = { sold: shown, forSale: before.forSale };
      try {
        expect(await compare()).toMatchObject({ outcome: 'check' });
      } finally {
        pages = before;
      }
    }
  });

  it('fails a search page Listora does not know, without throwing', async () => {
    const before = pages;
    pages = {
      sold: '<!doctype html><title>Poshmark</title><main>Something new</main>',
      forSale: '',
    };
    try {
      expect(await compare()).toMatchObject({ outcome: 'failed' });
    } finally {
      pages = before;
    }
  });
});

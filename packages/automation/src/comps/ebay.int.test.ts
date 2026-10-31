/**
 * eBay's comparison reads on the phone's page backend (comps/run.ts), in headless Chromium
 * standing in for the app's comparison web view, against a local stand-in of eBay's public search
 * results: the sold and for-sale searches matched and counted (the brand and type in the title,
 * results after "Results matching fewer words" left out, and lots, price ranges, and accepted
 * best offers never counted), the warm-up, and every way a read stops. There is no recording of
 * the real pages yet (eBay showed the recorder a bot check; docs/features/thrift-scan.md, "eBay"),
 * so the stand-in follows Listora's model of them (ebay/pages/search-page.ts).
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

/** One invented result as eBay's results page shows it (its card layout). */
function card(title: string, price: string, caption = ''): string {
  return `<li class="s-card s-card--horizontal" data-listingid="100000000001">
    <div class="s-card__caption"><span class="su-styled-text">${caption}</span></div>
    <a class="su-link" href="/itm/100000000001"><div class="s-card__title">
      <span class="su-styled-text primary">${title}</span>
      <span class="clipped">Opens in a new window or tab</span></div></a>
    <div class="s-card__attribute-row"><span class="s-card__price">${price}</span></div>
    <div class="s-card__attribute-row"><span class="s-card__seller-info">someone 99.5% positive</span></div>
  </li>`;
}

function resultsPage(count: string, cards: readonly string[]): string {
  return `<!doctype html><title>levis 501 jeans | eBay</title>
    <h1 class="srp-controls__count-heading"><span class="BOLD">${count}</span> results for levis 501 jeans</h1>
    <ul class="srp-results srp-list clearfix">${cards.join('')}</ul>`;
}

const SOLD = [
  card("Levi's 501 Jeans Men's 32x30 Medium Wash", '$28.00', 'Sold  Oct 29, 2026'),
  card('Levis 501 Original Fit Jeans W32 L30', '$32.50', 'Sold  Oct 27, 2026'),
  card("Levi's 501 Button Fly Jeans Size 32x30", '$25.00', 'Sold  Oct 24, 2026'),
  card("Vintage Levi's 501 Jeans 32x30 USA", '$45.00', 'Sold  Oct 20, 2026'),
  card("Levi's 501 Jeans 32 x 30 Black", '$30.00', 'Sold  Oct 17, 2026'),
  card(
    "Levi's 501 Jeans 32x30",
    '$<span class="STRIKETHROUGH">40.00</span>',
    'Sold  Oct 16, 2026 · Best offer accepted',
  ),
  card("Lot of 3 Levi's 501 Jeans 32x30", '$60.00', 'Sold  Oct 15, 2026'),
  card("Levi's Trucker Jacket Size M", '$40.00', 'Sold  Oct 14, 2026'),
  `<li class="srp-river-answer srp-river-answer--REWRITE_START"><h3>Results matching fewer words</h3></li>`,
  card("Levi's 505 Jeans 32x30", '$15.00', 'Sold  Oct 30, 2026'),
];

const FOR_SALE = [
  card('Shop on eBay', '$20.00'),
  card("Levi's 501 Jeans 32x30 Light Wash", '$35.00'),
  card('Levis 501 jeans 32 x 30', '$29.99'),
  card("Levi's 501 Original Jeans Sizes 28-40", '$20.00 to $45.00'),
  card("Levi's 550 Relaxed Jeans 32x30", '$22.00'),
];

describe("eBay's comparison reads", () => {
  let browser: Browser;
  let context: BrowserContext;
  let server: Server;
  let siteUrl: string;
  /** What the stand-in shows: the sold and for-sale results pages, and its home page. */
  let pages = { sold: resultsPage('1,204', SOLD), forSale: resultsPage('2,310', FOR_SALE) };
  const home = '<!doctype html><title>Electronics, Cars, Fashion | eBay</title><main>eBay</main>';
  const requested: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/sch/i.html') {
        requested.push(url.search);
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(url.searchParams.get('LH_Sold') === '1' ? pages.sold : pages.forSale);
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
      marketplace: 'ebay',
      query: {
        words: 'levis 501 jeans',
        brand: "Levi's",
        model: '501',
        sizeLabel: '32x30',
        productTypes: [],
        typeWords: ['jeans', 'denim'],
      },
      pacing: QUICK_PACING,
      stepTimeoutMs: 5_000,
      callTimeoutMs: 15_000,
      now: '2026-10-31T12:00:00Z',
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
        // The sold 501s in 32x30, the $45 vintage pair past the outliers; the accepted best
        // offer, the lot, and the 505 past "fewer words" are never read, and the jacket never
        // matches. The oldest of the five sold 14 days before.
        sold: {
          count: 4,
          lowCents: 2725,
          medianCents: 2900,
          highCents: 3063,
          windowDays: 14,
        },
        forSale: { count: 2, lowCents: 3124, medianCents: 3250, highCents: 3375 },
        read: { sold: 6, forSale: 3 },
      },
      forSaleTotal: 2310,
      soldTotal: 1204,
      ms: expect.any(Number) as number,
    });
    // Only the pages eBay's own filters and sort make: sold, ended recently first; then for sale.
    expect(requested).toEqual([
      '?_nkw=levis+501+jeans&LH_Sold=1&LH_Complete=1&_sop=13',
      '?_nkw=levis+501+jeans',
    ]);
  });

  it('reads a search with no results as none', async () => {
    const before = pages;
    pages = {
      sold: '<!doctype html><title>eBay</title><h1 class="srp-controls__count-heading">0 results found</h1>',
      forSale: before.forSale,
    };
    try {
      expect(await compare()).toMatchObject({
        outcome: 'read',
        stats: { read: { sold: 0, forSale: 3 } },
        soldTotal: 0,
      });
    } finally {
      pages = before;
    }
  });

  it('warms up by opening the home page', async () => {
    const host = new PlaywrightPhoneHost(await context.newPage());
    try {
      const warm = await warmUpComparisons({ marketplace: 'ebay' }, host, {
        siteUrl,
        pacing: { random: () => 0, sleep: () => Promise.resolve() },
      });
      expect(warm.outcome).toBe('warm');
      expect(host.page.url()).toBe(`${siteUrl}/`);
    } finally {
      await host.page.close();
    }
  });

  it("stops at eBay's security check and never passes it", async () => {
    const before = pages;
    pages = {
      sold: '<!doctype html><title>Pardon Our Interruption...</title><p>Please verify yourself</p>',
      forSale: before.forSale,
    };
    try {
      expect(await compare()).toMatchObject({ outcome: 'check' });
    } finally {
      pages = before;
    }
  });

  it('fails a results page Listora does not know, without throwing', async () => {
    const before = pages;
    pages = { sold: '<!doctype html><title>eBay</title><main>Something new</main>', forSale: '' };
    try {
      expect(await compare()).toMatchObject({ outcome: 'failed' });
    } finally {
      pages = before;
    }
  });
});

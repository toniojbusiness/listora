/**
 * Vinted's comparison reads on the phone's page backend (comps/run.ts), in headless Chromium
 * standing in for the app's comparison web view, against a local stand-in of Vinted's public
 * search with invented listings, drawn as the recorded real page draws its item boxes
 * (vinted/recordings/search.json): the search matched and counted (the brand Vinted names or the
 * title's words, the type in the title, the model and the size; lots and boxes of other grids
 * never counted), the search's count, the warm-up, and every way a read stops.
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

interface Invented {
  readonly id: number;
  readonly title: string;
  readonly price: string;
  readonly brand: string;
  /** The box's subtitle: the size, then the condition. */
  readonly subtitle: string;
}

/** One invented listing as Vinted's item box draws it. */
function box(item: Invented): string {
  const id = `product-item-id-${String(item.id)}`;
  const label = `${item.title}, Brand: ${item.brand}, Condition: Very good, Size: ${item.subtitle.split(' · ')[0] ?? ''}, ${item.price.slice(1)} $`;
  return `<div data-testid="grid-item"><div><div data-testid="${id}">
    <div data-testid="${id}--image"><img alt="${label}" src="data:,"></div>
    <a href="/items/${String(item.id)}-listing?referrer=catalog" data-testid="${id}--overlay-link" title="${label}"><div></div></a>
    <button data-testid="${id}--favourite" aria-label="Add to favorites">3</button>
    <div data-testid="${id}--summary">
      <p data-testid="${id}--description-title">${item.brand}</p>
      <p data-testid="${id}--description-subtitle">${item.subtitle}</p>
      <p data-testid="${id}--price-text">${item.price}</p>
    </div></div></div></div>`;
}

/** The results page: the count, the grid of results, and a box outside it. */
function searchPage(items: readonly Invented[], count = '500+ results.'): string {
  const outside = box({
    id: 999,
    title: "Levi's 501 jeans rare",
    price: '$400.00',
    brand: "Levi's",
    subtitle: 'W28 · Very good',
  }).replace('data-testid="grid-item"', 'data-testid="closet-promotion"');
  return `<!doctype html><title>Items | Vinted</title>
    <main><span class="web_ui__Text__text web_ui__Text__subtitle">${count}</span>
    <div class="feed-grid">${items.map(box).join('')}</div>
    <aside>${outside}</aside></main>`;
}

const FOR_SALE: Invented[] = [
  { id: 1, title: "Levi's 501 jeans", price: '$25.00', brand: "Levi's", subtitle: 'W28 · Good' },
  { id: 2, title: 'Levis 501 90s jeans', price: '$30.00', brand: "Levi's", subtitle: 'W28 · Good' },
  { id: 3, title: '501 button fly jeans', price: '$20.00', brand: "Levi's", subtitle: 'W28 · New' },
  {
    id: 4,
    title: "Levi's 501 vintage denim",
    price: '$35.00',
    brand: "Levi's",
    subtitle: 'W28 · Good',
  },
  {
    id: 5,
    title: "Levi's 501 straight jeans",
    price: '$28.00',
    brand: "Levi's",
    subtitle: 'W28 · Good',
  },
  // Another size, another model, a lot, another type, another brand: never close matches.
  { id: 6, title: "Levi's 501 jeans", price: '$22.00', brand: "Levi's", subtitle: 'W34 · Good' },
  {
    id: 7,
    title: "Levi's 550 relaxed jeans",
    price: '$18.00',
    brand: "Levi's",
    subtitle: 'W28 · Good',
  },
  {
    id: 8,
    title: "Lot of 3 Levi's 501 jeans",
    price: '$60.00',
    brand: "Levi's",
    subtitle: 'W28 · Good',
  },
  {
    id: 9,
    title: "Levi's trucker jacket",
    price: '$40.00',
    brand: "Levi's",
    subtitle: 'M / US 8-10 · Good',
  },
  {
    id: 10,
    title: 'Wrangler 501 style jeans',
    price: '$15.00',
    brand: 'Wrangler',
    subtitle: 'W28 · Good',
  },
];

describe("Vinted's comparison reads", () => {
  let browser: Browser;
  let context: BrowserContext;
  let server: Server;
  let siteUrl: string;
  let page = searchPage(FOR_SALE);
  const home = '<!doctype html><title>Vinted</title><main>Vinted</main>';
  const requested: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (url.pathname === '/catalog') {
        requested.push(url.search);
        response.end(page);
        return;
      }
      if (url.pathname.startsWith('/member/signup')) {
        response.end(
          '<!doctype html><title>Sign up | Vinted</title><form><input type="password"></form>',
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
      marketplace: 'vinted',
      query: {
        words: 'levis 501 jeans',
        brand: "Levi's",
        model: '501',
        sizeLabel: '28',
        productTypes: [],
        typeWords: ['jeans', 'denim'],
      },
      pacing: QUICK_PACING,
      stepTimeoutMs: 3_000,
      callTimeoutMs: 15_000,
      now: '2026-11-05T12:00:00Z',
    };
  }

  async function compare(shown: string = page) {
    const before = page;
    page = shown;
    const host = new PlaywrightPhoneHost(await context.newPage());
    try {
      return await runComparison(input(), host, {
        siteUrl,
        pacing: { random: () => 0, sleep: () => Promise.resolve() },
      });
    } finally {
      await host.page.close();
      page = before;
    }
  }

  it("reads the search's asking prices and counts only the item's close matches", async () => {
    requested.length = 0;
    expect(await compare()).toEqual({
      outcome: 'read',
      stats: {
        // The five 501s in a W28 (a 28); never the W34, the 550, the lot, the jacket, the
        // Wrangler, or the $400 pair outside the search's grid.
        level: 'model_and_size',
        forSale: { count: 5, lowCents: 2500, medianCents: 2800, highCents: 3000 },
        read: { sold: 0, forSale: 9 },
      },
      // Vinted's "500+" is at least 500.
      forSaleTotal: 500,
      ms: expect.any(Number) as number,
    });
    // The one page Vinted's own search bar makes; nothing else.
    expect(requested).toEqual(['?search_text=levis%20501%20jeans']);
  });

  it('reads a page without its count as having none', async () => {
    expect(await compare(searchPage(FOR_SALE, ''))).toMatchObject({
      outcome: 'read',
      forSaleTotal: null,
    });
  });

  it('reads a search with no results as none', async () => {
    expect(await compare(searchPage([], '0 results.'))).toMatchObject({
      outcome: 'read',
      stats: { read: { sold: 0, forSale: 0 } },
      forSaleTotal: 0,
    });
  });

  it('warms up by opening the home page', async () => {
    const host = new PlaywrightPhoneHost(await context.newPage());
    try {
      const warm = await warmUpComparisons({ marketplace: 'vinted' }, host, {
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
    expect(await compare(check)).toMatchObject({ outcome: 'check' });
  });

  it("stops at DataDome's CAPTCHA and never passes it", async () => {
    const captcha =
      '<!doctype html><title>vinted.com</title><iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=x" width="400" height="400"></iframe>';
    expect(await compare(captcha)).toMatchObject({ outcome: 'check' });
  });

  it('stops at a sign-in page and never signs in', async () => {
    const redirect = `<!doctype html><title>Vinted</title><script>location.replace('/member/signup/select_type')</script>`;
    expect(await compare(redirect)).toMatchObject({ outcome: 'check' });
  });

  it('fails a results page Listora does not know, without throwing', async () => {
    const unknown = '<!doctype html><title>Vinted</title><main>Something new</main>';
    expect(await compare(unknown)).toMatchObject({ outcome: 'failed' });
  });
});

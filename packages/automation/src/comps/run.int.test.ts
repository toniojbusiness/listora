/**
 * The comparison lane on the phone's page backend (comps/run.ts), in headless Chromium standing
 * in for the app's comparison web view, against a local stand-in of Depop's public search: a read
 * that matches and counts, and every way a read stops (a bot check, a CAPTCHA page, a 403 that
 * is not JSON, a rate limit). The real page's shape is held by the recorded search
 * (depop/recordings/search.json, recordings.int.test.ts).
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

/** An invented product as Depop's search answers one. */
function product(price: string, overrides: Record<string, unknown> = {}) {
  return {
    brand_name: "Levi's",
    status: 'STATUS_ONSALE',
    description: "Levi's 501 jeans, light wash",
    sizes: [{ name: '28' }],
    attributes: { product_type: 'jeans', brand: 'levi-s' },
    pricing: {
      currency_name: 'USD',
      current_price: { price_breakdown: { price: { amount: price } } },
    },
    slug: 'someone-levis-501-jeans-1a2b',
    ...overrides,
  };
}

const PRODUCTS = [
  product('15.00'),
  product('18.00'),
  product('20.00'),
  product('22.00'),
  product('25.00'),
  product('30.00', { description: "Levi's 550 relaxed jeans" }),
  product('60.00', { attributes: { product_type: 'jackets' }, description: "Levi's trucker" }),
  product('12.00', { brand_name: 'Wrangler', description: 'Wrangler 501 jeans' }),
];

describe('the comparison lane', () => {
  let browser: Browser;
  let context: BrowserContext;
  let server: Server;
  let siteUrl: string;
  /** How the stand-in answers the search's API, and what its search page shows. */
  let api: { status: number; type: string; body: string } = ok();
  let searchPage = '<!doctype html><title>Search | Depop</title><main>Search</main>';

  function ok() {
    return {
      status: 200,
      type: 'application/json',
      body: JSON.stringify({ meta: { total_count: 41 }, page_info: {}, objects: PRODUCTS }),
    };
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url?.startsWith('/presentation/api/v1/search/products/')) {
        response.writeHead(api.status, { 'content-type': api.type });
        response.end(api.body);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(searchPage);
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
      marketplace: 'depop',
      query: {
        words: 'levis 501 jeans',
        brand: "Levi's",
        model: '501',
        sizeLabel: '28',
        productTypes: ['jeans'],
        typeWords: ['jeans'],
      },
      pacing: QUICK_PACING,
      stepTimeoutMs: 5_000,
      callTimeoutMs: 15_000,
      now: '2026-10-31T00:00:00Z',
    };
  }

  async function compare(override?: Partial<ComparisonInput>) {
    const host = new PlaywrightPhoneHost(await context.newPage());
    try {
      return await runComparison({ ...input(), ...override }, host, {
        siteUrl,
        pacing: { random: () => 0, sleep: () => Promise.resolve() },
      });
    } finally {
      await host.page.close();
    }
  }

  it('reads the search from its page and counts only the same brand, type, model, and size', async () => {
    api = ok();
    const output = await compare();
    expect(output).toEqual({
      outcome: 'read',
      stats: {
        level: 'model_and_size',
        forSale: { count: 5, lowCents: 1800, medianCents: 2000, highCents: 2200 },
        read: { sold: 0, forSale: 8 },
      },
      forSaleTotal: 41,
      ms: expect.any(Number) as number,
    });
  });

  it('sends no level when nothing matched, as the API takes the answer', async () => {
    api = {
      status: 200,
      type: 'application/json',
      body: JSON.stringify({ meta: { total_count: 3 }, objects: [PRODUCTS[6], PRODUCTS[7]] }),
    };
    try {
      const output = await compare();
      expect(output).toMatchObject({ outcome: 'read', stats: { read: { sold: 0, forSale: 2 } } });
      expect(output.outcome === 'read' && 'level' in output.stats).toBe(false);
    } finally {
      api = ok();
    }
  });

  it('warms up by opening the search page', async () => {
    const host = new PlaywrightPhoneHost(await context.newPage());
    try {
      const warm = await warmUpComparisons(input(), host, { siteUrl });
      expect(warm.outcome).toBe('warm');
      expect(host.page.url()).toBe(`${siteUrl}/search/`);
    } finally {
      await host.page.close();
    }
  });

  it('stops at a bot check, a 403 that is not JSON, or a rate limit, and never passes one', async () => {
    api = { status: 403, type: 'text/html', body: '<html>Access denied</html>' };
    expect(await compare()).toMatchObject({ outcome: 'check' });
    api = { status: 429, type: 'application/json', body: '{}' };
    expect(await compare()).toMatchObject({ outcome: 'rate_limited' });
    api = ok();
    searchPage = '<!doctype html><title>Just a moment...</title><p>Checking your browser</p>';
    try {
      expect(await compare()).toMatchObject({ outcome: 'check' });
    } finally {
      searchPage = '<!doctype html><title>Search | Depop</title><main>Search</main>';
    }
  });

  it('fails a read of another version, or an answer Listora does not know, without throwing', async () => {
    expect(await compare({ version: 99 })).toMatchObject({ outcome: 'failed' });
    api = { status: 200, type: 'application/json', body: '{"unexpected":true}' };
    expect(await compare()).toMatchObject({ outcome: 'failed' });
    api = ok();
  });
});

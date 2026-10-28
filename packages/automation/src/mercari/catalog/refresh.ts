/**
 * Refreshes `catalog.json` (docs/features/mercari.md, "The catalog") from Mercari's own sell
 * page, on the seller's signed-in Chrome:
 *
 *   node packages/automation/src/mercari/catalog/refresh.ts [--cdp http://127.0.0.1:9333]
 *
 * It attaches to that Chrome over its DevTools port, opens one background tab on Mercari's sell
 * page, and reads what the page itself reads: the master data (categories, size groups, sizes,
 * conditions) and, for each phone, tablet, and wearable category, the page's sell check that
 * says whether the form asks for an IMEI, one request every two seconds. It only reads: it fills
 * nothing and sends no listing. It stops at once if Mercari shows a sign-in page or any check;
 * the seller signs in again in that Chrome and runs it again. Nothing it reads is printed or kept
 * except the catalog, and the session's own headers stay in the page.
 */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import type { Browser, Page, Request } from 'playwright-core';

import { loadChromium } from '../../runner/playwright.ts';
import { MERCARI_PATHS, MERCARI_SITE_URL } from '../site.ts';
import { buildMercariCatalog, formatMercariCatalog, type MercariMasterData } from './build.ts';

const CATALOG_FILE = new URL('catalog.json', import.meta.url);
/** The departments' subtrees whose categories might sell a device with an IMEI. */
const IMEI_SUBTREES = /^(Cell phones & accessories|Tablets & E-readers|Wearables)$/;
const SELL_CHECK_EVERY_MS = 2_000;
/**
 * Categories whose sell form showed its IMEI field when filled on the seller's session, though
 * the sell check sent this way said no (2026-10-27): kept whatever the check says.
 */
const IMEI_SEEN_ON_FORM = [
  ['Electronics', 'Cell phones & accessories', 'Cell phones & smartphones'],
];

const MASTER_QUERY = `query masterQuery {
  master {
    itemCategories { id name parentId itemSizeGroupId displayOrder }
    itemSizeGroups { id title category sizeIds subGroupIds }
    itemSizeSubGroups { id title sizeIds }
    itemSizes { id title subtitle itemSizeGroupId itemSizeSubGroupId displayOrder }
    itemConditions { id name }
  }
}`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { cdp: { type: 'string', default: 'http://127.0.0.1:9333' } },
  });
  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP(values.cdp);
  const page = await backgroundTab(browser);
  try {
    // The sell page's own sell check, whose persisted query and headers the reads reuse.
    const sellCheck = page.waitForRequest((request) => isSellCheck(request), { timeout: 30_000 });
    await page.goto(`${MERCARI_SITE_URL}${MERCARI_PATHS.sell}`, { waitUntil: 'domcontentloaded' });
    stopAtChecks(page);
    const template = await sellCheck;
    const headers = sessionHeaders(template);
    const master = await readMaster(page, headers);
    const imei = [
      ...(await readImeiCategories(page, template, headers, master)),
      ...seenOnForm(master),
    ];
    const catalog = buildMercariCatalog(master, imei, new Date().toISOString().slice(0, 10));
    await writeFile(CATALOG_FILE, formatMercariCatalog(catalog));
    // The repository's own formatting, which `npm run format:check` holds every JSON file to.
    execFileSync('npx', ['prettier', '--write', fileURLToPath(CATALOG_FILE)], { stdio: 'ignore' });
    const counted = master.itemCategories.length;
    process.stdout.write(
      `Wrote ${CATALOG_FILE.pathname}: ${String(counted)} categories, ${String(catalog.sizeGroups.length)} size groups, ${String(imei.length)} asking for an IMEI.\n`,
    );
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** The ids of `IMEI_SEEN_ON_FORM`'s categories in the master data. */
function seenOnForm(master: MercariMasterData): number[] {
  return IMEI_SEEN_ON_FORM.flatMap((path) => {
    let parentId = 0;
    let id: number | undefined;
    for (const name of path) {
      id = master.itemCategories.find(
        (category) => category.parentId === parentId && category.name === name,
      )?.id;
      if (id === undefined) return [];
      parentId = id;
    }
    return id === undefined ? [] : [id];
  });
}

/** A new tab that opens behind the seller's own, so their window never changes. */
async function backgroundTab(browser: Browser): Promise<Page> {
  const context = browser.contexts()[0];
  if (context === undefined) throw new Error('That Chrome has no window open.');
  const cdp = await browser.newBrowserCDPSession();
  const created = await cdp.send('Target.createTarget', { url: 'about:blank', background: true });
  for (let tries = 0; tries < 50; tries += 1) {
    for (const page of context.pages()) {
      const session = await context.newCDPSession(page);
      const info = (await session.send('Target.getTargetInfo')) as {
        targetInfo: { targetId: string };
      };
      await session.detach();
      if (info.targetInfo.targetId === created.targetId) return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The background tab did not open.');
}

/** Stops the run if Mercari leaves its sell page for a sign-in page or a check. */
function stopAtChecks(page: Page): void {
  const path = new URL(page.url()).pathname;
  if (path !== MERCARI_PATHS.sell) {
    throw new Error(
      `Mercari opened ${path} instead of its sell page: sign in to Mercari in that Chrome, then run this again.`,
    );
  }
}

function isSellCheck(request: Request): boolean {
  const url = new URL(request.url());
  return url.pathname === '/v1/api' && url.searchParams.get('operationName') === 'sellQuery';
}

/** The headers Mercari's page sends its API (its session's), kept only inside the page. */
function sessionHeaders(request: Request): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request.headers()).filter(([name]) =>
      /^(authorization|content-type|accept|apollo-require-preflight|x-[a-z-]+)$/i.test(name),
    ),
  );
}

interface ApiRequest {
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

async function api(page: Page, url: string, init: ApiRequest): Promise<unknown> {
  const answer = await page.evaluate(
    async ({ url, init }) => {
      const response = await fetch(url, { ...init, credentials: 'include' });
      return { status: response.status, text: await response.text() };
    },
    { url, init },
  );
  if (answer.status !== 200) {
    throw new Error(`Mercari's API answered ${String(answer.status)}; run this again later.`);
  }
  const body = JSON.parse(answer.text) as { data?: unknown; errors?: { message: string }[] };
  if (body.errors !== undefined && body.errors.length > 0) {
    throw new Error(`Mercari's API refused the read: ${body.errors[0]?.message ?? 'no reason'}.`);
  }
  return body.data;
}

async function readMaster(page: Page, headers: Record<string, string>): Promise<MercariMasterData> {
  const data = (await api(page, '/v1/api', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ operationName: 'masterQuery', variables: {}, query: MASTER_QUERY }),
  })) as { master?: MercariMasterData } | undefined;
  if (data?.master === undefined || data.master.itemCategories.length === 0) {
    throw new Error("Mercari's master data came back empty.");
  }
  return data.master;
}

/**
 * The categories whose sell check asks for an IMEI. The check is the page's own persisted
 * query, sent again with each category in place of none.
 */
async function readImeiCategories(
  page: Page,
  template: Request,
  headers: Record<string, string>,
  master: MercariMasterData,
): Promise<number[]> {
  const roots = master.itemCategories.filter((category) => IMEI_SUBTREES.test(category.name));
  const ids = new Set(roots.map((root) => root.id));
  for (const category of master.itemCategories) {
    if (ids.has(category.parentId)) ids.add(category.id);
  }
  const imei: number[] = [];
  for (const id of ids) {
    const url = new URL(template.url());
    const variables = JSON.parse(url.searchParams.get('variables') ?? '{}') as {
      sellInput?: Record<string, unknown>;
    };
    variables.sellInput = { ...variables.sellInput, categoryId: id };
    url.searchParams.set('variables', JSON.stringify(variables));
    const data = (await api(page, `${url.pathname}${url.search}`, { headers })) as
      { sell?: { isImeiRequired?: boolean } } | undefined;
    if (data?.sell?.isImeiRequired === true) imei.push(id);
    await new Promise((resolve) => setTimeout(resolve, SELL_CHECK_EVERY_MS));
  }
  return imei;
}

await main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);

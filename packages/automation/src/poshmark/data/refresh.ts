/**
 * Rewrites `catalog.json` from Poshmark's own listing form (normalize.ts says what it reads).
 * The form is shown only to a signed-in seller, so the catalog is read from a browser where one
 * is signed in, read-only (nothing on the form is filled in or saved):
 *
 *   node packages/automation/src/poshmark/data/refresh.ts --cdp http://127.0.0.1:9333
 *     opens /create-listing in a new tab of the Chrome listening there, reads it, closes the tab
 *   node packages/automation/src/poshmark/data/refresh.ts --from dump.json
 *     reads a dump of the same values, saved from the form's DevTools console with
 *     copy(JSON.stringify(<the expression in FORM_EXPRESSION>))
 *
 * It prints what changed (departments, categories, subcategories, and size sets), so a refresh
 * that drops a category is seen before it is committed. docs/features/poshmark.md has the steps.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { chromium } from 'playwright-core';
import { format, resolveConfig } from 'prettier';

import {
  formCatalogSchema,
  normalizeCatalog,
  type CatalogData,
  type FormCatalog,
} from './normalize.ts';

export const CATALOG_PATH = fileURLToPath(new URL('./catalog.json', import.meta.url));

/** What the form's page state is read with, in the page. */
export const FORM_EXPRESSION = `(() => {
  const state = window.__INITIAL_STATE__;
  const editor = state.$_listing_editor;
  return {
    catalogMeta: editor.catalogMeta,
    grouping: editor.catalogDisplayGroupingData,
    conditions: state.common.featureSettings.featureSettingsV3.web_resell_v2_guest.conditions,
  };
})()`;

async function readFromBrowser(cdpUrl: string): Promise<unknown> {
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const [context] = browser.contexts();
    if (context === undefined) throw new Error('the browser has no window to open a tab in');
    const page = await context.newPage();
    try {
      await page.goto('https://poshmark.com/create-listing', { waitUntil: 'domcontentloaded' });
      if (new URL(page.url()).pathname !== '/create-listing') {
        throw new Error(`Poshmark sent the tab to ${page.url()}: sign in to Poshmark there first`);
      }
      await page.waitForFunction(
        () =>
          (globalThis as unknown as { __INITIAL_STATE__?: { $_listing_editor?: unknown } })
            .__INITIAL_STATE__?.$_listing_editor !== undefined,
      );
      return await page.evaluate(FORM_EXPRESSION);
    } finally {
      await page.close();
    }
  } finally {
    // Disconnects; the browser and its other tabs stay as they were.
    await browser.close();
  }
}

function counts(data: CatalogData): Map<string, string> {
  const lines = new Map<string, string>();
  for (const department of data.departments) {
    for (const category of department.categories) {
      lines.set(
        `${department.name}/${category.name}`,
        `${String(category.subcategories.length)} subcategories, size sets ${category.sizeSets.join(', ') || 'none'}`,
      );
    }
  }
  return lines;
}

/** What changed between the committed catalog and the new one, one line per category. */
export function describeChanges(before: CatalogData | null, after: CatalogData): string[] {
  const old = before === null ? new Map<string, string>() : counts(before);
  const next = counts(after);
  const changes: string[] = [];
  for (const [name, line] of next) {
    const was = old.get(name);
    if (was === undefined) changes.push(`+ ${name}: ${line}`);
    else if (was !== line) changes.push(`~ ${name}: ${was} → ${line}`);
  }
  for (const name of old.keys()) if (!next.has(name)) changes.push(`- ${name}`);
  return changes;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { cdp: { type: 'string' }, from: { type: 'string' } } });
  if ((values.cdp === undefined) === (values.from === undefined)) {
    throw new Error('pass --cdp <url> or --from <file> (see the comment at the top of refresh.ts)');
  }
  const raw =
    values.from === undefined
      ? await readFromBrowser(values.cdp ?? '')
      : (JSON.parse(await readFile(values.from, 'utf8')) as unknown);
  const form: FormCatalog = formCatalogSchema.parse(raw);
  const data = normalizeCatalog(form, new Date().toISOString().slice(0, 10));
  const before = await readFile(CATALOG_PATH, 'utf8').then(
    (text) => JSON.parse(text) as CatalogData,
    () => null,
  );
  const options = (await resolveConfig(CATALOG_PATH)) ?? {};
  const text = await format(JSON.stringify(data), { ...options, filepath: CATALOG_PATH });
  await writeFile(CATALOG_PATH, text);
  const changes = describeChanges(before, data);
  process.stdout.write(
    `wrote ${CATALOG_PATH}\n${changes.length === 0 ? 'no category changed' : changes.join('\n')}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

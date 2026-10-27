/**
 * Refreshes `taxonomy.json` from Depop itself: `npm run depop:taxonomy` (in this package).
 *
 * It reads the data Depop's own sell form loads from Depop's web API, in a background tab of a
 * Chrome where a seller is signed in to Depop, the way the form reads it (a GET from the page,
 * with the page's own token), and writes Depop's whole category tree, size lists, and form
 * fields as `taxonomy.json`. Only reads: nothing is filled in or posted. Run it when Depop
 * changes its categories (a listing then stops with "has no category group ..."), review the
 * diff, and commit it with the mapping changes it needs (`categories.test.ts` says which).
 *
 * The Chrome must have remote debugging on (`--remote-debugging-port=9333`);
 * `DEPOP_TAXONOMY_CDP_URL` points at another one. Development only: nothing in Listora runs it.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { format } from 'prettier';
import { z } from 'zod';

import { loadChromium } from '../../runner/playwright.ts';
import { apiGetScript } from '../../runner/script-session.ts';
import { taxonomySchema, type DepopTaxonomy } from './schema.ts';

const OUTPUT = fileURLToPath(new URL('./taxonomy.json', import.meta.url));
const SELL_PAGE = 'https://www.depop.com/products/create/';
const API = 'https://webapi.depop.com/presentation/api';

/** What the sell form loads, by the name `buildTaxonomy` reads it under. */
export const SOURCES = {
  categories: `${API}/v2/search/filters/category/?lang=en-US`,
  attributes: `${API}/v1/attributes/`,
  sizes: `${API}/v1/attributes/categories/size-mapping/`,
  bannedHashtags: `${API}/v1/listing/banned-hashtags/`,
} as const;

export type RawSources = Record<keyof typeof SOURCES, unknown>;

const i18n = z.record(z.string(), z.string());
const named = (value: { 'en-US'?: string; en?: string } | undefined, fallback: string) =>
  (value?.['en-US'] ?? value?.en ?? fallback).trim();

const rawSchema = z.object({
  categories: z.object({
    departments: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        children: z.array(z.object({ id: z.string(), name: z.string() })),
      }),
    ),
    groups: z.record(
      z.string(),
      z.array(z.object({ id: z.string(), name: z.string(), department: z.array(z.string()) })),
    ),
  }),
  attributes: z
    .object({
      department: z.array(
        z.object({ id: z.string(), gender: z.object({ is_displayed: z.boolean() }).optional() }),
      ),
      group: z.array(
        z.object({
          id: z.string(),
          name_i18n: i18n,
          product_types: z.array(
            z.object({
              id: z.string(),
              name_i18n: i18n.optional(),
              attribute_ids: z.array(z.string()).optional(),
            }),
          ),
        }),
      ),
      generic_attributes: z.array(z.unknown()),
    })
    .catchall(z.unknown()),
  sizes: z.object({
    category_size_mapping: z.array(
      z.object({
        department: z.string(),
        group: z.string(),
        product_type: z.string(),
        size_set_by_region: z.record(z.string(), z.number()).optional(),
      }),
    ),
    size_sets: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        sizes: z.array(z.object({ name_i18n: i18n })),
      }),
    ),
  }),
  bannedHashtags: z.object({ banned_hashtags: z.array(z.string()) }),
});

const attributeGroupSchema = z.object({
  id: z.string(),
  name_i18n: i18n.optional(),
  max_selection: z.number(),
  status: z.string().optional(),
  attributes: z.array(
    z.object({
      id: z.string(),
      status: z.string().optional(),
      name: z.string().optional(),
      name_i18n: i18n.optional(),
      department: z.array(z.string()).optional(),
    }),
  ),
});

/** The form's own fields besides the category, brand, condition, and size. */
const FORM_FIELDS = ['colour', 'style', 'age', 'source'] as const;

/** Depop's raw answers as Listora's taxonomy: US names and sizes, active entries, sorted ids. */
export function buildTaxonomy(raw: RawSources, fetchedAt: string): DepopTaxonomy {
  const { categories, attributes, sizes, bannedHashtags } = rawSchema.parse(raw);
  const typeNames = new Map<string, string>();
  for (const [group, types] of Object.entries(categories.groups)) {
    for (const type of types) typeNames.set(`${group}/${type.id}`, type.name.trim());
  }
  const groupData = new Map(attributes.group.map((group) => [group.id, group]));
  const sizeSets = new Map(sizes.size_sets.map((set) => [set.id, set]));
  const usedSets = new Set<number>();

  const departments = categories.departments.map((department) => {
    const groups = department.children.flatMap((child) => {
      const group = groupData.get(child.id);
      const mapped = sizes.category_size_mapping.filter(
        (entry) => entry.department === department.id && entry.group === child.id,
      );
      // The form's own list (in its order), then any product type only the size map names.
      const ids = [
        ...(categories.groups[child.id] ?? [])
          .filter((type) => type.department.includes(department.id))
          .map((type) => type.id),
        ...mapped.map((entry) => entry.product_type),
      ];
      const productTypes = [...new Set(ids)].map((id) => {
        const type = group?.product_types.find((candidate) => candidate.id === id);
        const entry = mapped.find((candidate) => candidate.product_type === id);
        const sizeSet = entry?.size_set_by_region?.['US'] ?? null;
        if (sizeSet !== null) usedSets.add(sizeSet);
        return {
          id,
          name: typeNames.get(`${child.id}/${id}`) ?? named(type?.name_i18n, id),
          sizeSet,
          attributes: [...(type?.attribute_ids ?? [])].sort(),
        };
      });
      if (productTypes.length === 0) return [];
      return [{ id: child.id, name: child.name.trim(), productTypes }];
    });
    const genders = attributes.department.find((entry) => entry.id === department.id)?.gender;
    return {
      id: department.id,
      name: department.name,
      asksGender: genders?.is_displayed ?? false,
      groups,
    };
  });

  const attributeSets: Record<string, DepopTaxonomy['attributes'][string]> = {};
  const addAttribute = (value: unknown) => {
    const parsed = attributeGroupSchema.safeParse(value);
    if (!parsed.success || (parsed.data.status ?? 'active') !== 'active') return;
    const group = parsed.data;
    attributeSets[group.id] = {
      name: named(group.name_i18n, group.id),
      max: group.max_selection,
      values: group.attributes
        .filter((entry) => (entry.status ?? 'active') === 'active')
        .map((entry) => ({
          id: entry.id,
          name: entry.name?.trim() ?? named(entry.name_i18n, entry.id),
          ...(entry.department === undefined ? {} : { departments: [...entry.department].sort() }),
        })),
    };
  };
  for (const field of FORM_FIELDS) addAttribute(attributes[field]);
  for (const generic of attributes.generic_attributes) addAttribute(generic);

  const usSizeSets: DepopTaxonomy['sizeSets'] = {};
  for (const id of [...usedSets].sort((a, b) => a - b)) {
    const set = sizeSets.get(id);
    if (set === undefined) continue;
    usSizeSets[String(id)] = {
      name: set.name,
      sizes: set.sizes.map((size) => named(size.name_i18n, '')),
    };
  }

  return taxonomySchema.parse({
    source: `Depop's sell form (${Object.values(SOURCES).join(', ')}), US English`,
    fetchedAt,
    departments,
    sizeSets: usSizeSets,
    attributes: Object.fromEntries(
      Object.entries(attributeSets).sort(([a], [b]) => a.localeCompare(b)),
    ),
    bannedHashtags: [
      ...new Set(bannedHashtags.banned_hashtags.map((tag) => tag.toLowerCase())),
    ].sort(),
  });
}

/** Reads every source in a background tab of the signed-in Chrome at `cdpUrl`. */
async function readSources(cdpUrl: string): Promise<RawSources> {
  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error('the Chrome has no browser window open');
    const cdp = await browser.newBrowserCDPSession();
    const opened = context.waitForEvent('page');
    // In the background: the seller's own tabs stay in front.
    const { targetId } = await cdp.send('Target.createTarget', {
      url: 'about:blank',
      background: true,
    });
    const page = await opened;
    try {
      await page.goto(SELL_PAGE, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await page.waitForSelector('textarea#description', { timeout: 30_000 });
      const read = async (url: string): Promise<unknown> => {
        // The same in-page read the scripts make (PageDriver.apiGet), with the page's own token.
        const answer = await page.evaluate<{ status: number; text: string | null }>(
          apiGetScript(url, 'access_token'),
        );
        if (answer.status !== 200 || answer.text === null) {
          throw new Error(`${url} answered ${String(answer.status)}`);
        }
        return JSON.parse(answer.text) as unknown;
      };
      const raw: Partial<RawSources> = {};
      for (const [name, url] of Object.entries(SOURCES)) {
        raw[name as keyof RawSources] = await read(url);
      }
      return raw as RawSources;
    } finally {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
    }
  } finally {
    // Disconnects only: the seller's Chrome keeps running.
    await browser.close();
  }
}

async function main(): Promise<void> {
  const cdpUrl = process.env['DEPOP_TAXONOMY_CDP_URL'] ?? 'http://127.0.0.1:9333';
  const taxonomy = buildTaxonomy(await readSources(cdpUrl), new Date().toISOString().slice(0, 10));
  const text = await format(JSON.stringify(taxonomy), { parser: 'json', printWidth: 100 });
  await writeFile(OUTPUT, text);
  const types = taxonomy.departments.flatMap((department) =>
    department.groups.flatMap((group) => group.productTypes),
  );
  process.stdout.write(
    `wrote ${OUTPUT}: ${String(taxonomy.departments.length)} departments, ${String(types.length)} product types, ${String(Object.keys(taxonomy.sizeSets).length)} size lists\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

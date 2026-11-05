/**
 * Vinted's upload form ("Sell an item | Vinted"): the upload page (`/items/new`) for a new
 * listing, and the same form on a listing's edit page (`/items/<id>/edit`). Filling it changes
 * nothing; only its Upload (Save on the edit page) does.
 *
 * The form, in the order the script fills it: photos (one file input, in posting order, up to
 * 20), title, description (with Listora's SKU line), the category level by level in its list
 * (each level's categories appear once the one above is picked, down to one without
 * subcategories), then the fields the category asks for: brand (searched in Vinted's list; its
 * "No brand" when Vinted lists none), size (the item's label in the category's list, when the
 * form asks one), condition, up to two colours, and the package size (Vinted's form recommends
 * one for the category, which Listora keeps unless the listing names one); then the price.
 *
 * Read on the test account (2026-11-05, Vinted plan M2's read of the bare form, nothing typed or
 * sent): the page's title, its category field (`catalog-select-dropdown-input`) and list
 * (`catalog-select-dropdown-content`, whose top levels are `catalog-icon-<id>` cells and whose
 * categories are picked by their names), and that picking a category asks Vinted for its fields
 * (`POST /api/v2/item_upload/attributes`). Vinted then sent the account to its verification
 * (`/users/verification`), a check the profile stops at, so every other part here is Listora's
 * model of the form, named after the category field's pattern, until the mapping reads it. A
 * part that differs stops the step before anything is sent (`PageChangedError`), and its fix is
 * this module's selectors.
 *
 * After Upload, Vinted either shows its messages under the fields it refuses (a rejection in
 * Vinted's own words), or opens the new listing's page (`/items/<id>-<slug>`), whose id the
 * script returns. Vinted then reviews the upload before it goes live: the read-back says so.
 */
import { withSkuLine } from '../../adapter/sku-line.ts';
import type { PageDriver, UploadFile } from '../../runner/types.ts';
import type { VintedListingPayload, VintedPackageSize } from '../payload.ts';
import { itemIdFromPath, VINTED_PATHS } from '../site.ts';
import {
  absolute,
  appears,
  awaitElement,
  changed,
  lookAgain,
  LOOK_EVERY_MS,
  quote,
  type VintedSite,
} from './common.ts';

/** A dropdown field of the form: its input, and the list it opens. */
const dropdown = (name: string) =>
  ({
    input: `[data-testid="${name}-select-dropdown-input"]`,
    list: `[data-testid="${name}-select-dropdown-content"]`,
  }) as const;

export const UPLOAD_FORM = {
  /** The form is there once its category field is (read on the test account). */
  form: '[data-testid="catalog-select-dropdown-input"]',
  photos: 'input[type="file"][data-testid="add-photos-input"]',
  /** A photo the form took, as its thumbnail. */
  photo: '[data-testid="item-photo"]',
  title: 'input[data-testid="title--input"]',
  description: 'textarea[data-testid="description--input"]',
  category: dropdown('catalog'),
  brand: dropdown('brand'),
  /** What to search for Vinted's brand for an item without one, and its name. */
  noBrand: 'No brand',
  size: dropdown('size'),
  condition: dropdown('status'),
  color: dropdown('color'),
  /** A package size's choice, and the one chosen (Vinted's recommendation, until changed). */
  packageSize: (size: VintedPackageSize) =>
    `input[type="radio"][data-testid="package-size--${size}"]`,
  packageSizeChosen: 'input[type="radio"][data-testid^="package-size--"]:checked',
  price: 'input[data-testid="price-input--input"]',
  /** Upload on the upload page, Save on the edit page: the one control that changes anything. */
  save: 'button[data-testid="upload-form-save-button"]',
  /** Vinted's message under a field it refuses. */
  error: '[data-testid$="--validation-text"]',
} as const;

/** An option of a list, by its whole name: the innermost element that shows it. */
function option(list: string, name: string): string {
  return `${list} *:text-is("${quote(name)}") >> nth=-1`;
}

const FORM = 'upload form';
/** How long a list Vinted draws after a tap, or the fields a category asks for, get to appear. */
const APPEAR_MS = 8_000;
/** How long the form gets to take every photo. */
const PHOTOS_MS = 30_000;
/** How long Vinted gets to answer an Upload or a Save. */
const ANSWER_MS = 30_000;

/** Why a form could not be filled as the listing asks, before anything was sent. */
export type FillProblem =
  | { type: 'size_not_offered'; size: string | null; offered: string[] }
  | { type: 'package_size_required' };

/** What an Upload or a Save came to. */
export type Submitted =
  { type: 'posted'; itemId: string | null } | { type: 'refused'; message: string };

/** Opens the empty upload form. */
export async function openUploadForm(page: PageDriver, site: VintedSite): Promise<void> {
  await page.goto(absolute(site, VINTED_PATHS.upload));
  await awaitElement(page, UPLOAD_FORM.form, FORM, 'category field');
}

/**
 * Opens the listing's edit form: `editing` once it shows the form, `missing` for a listing
 * Vinted no longer has (404), and `not_editable` for a page without the form (one that sold).
 */
export async function openEditForm(
  page: PageDriver,
  site: VintedSite,
  id: string,
): Promise<'editing' | 'missing' | 'not_editable'> {
  await page.goto(absolute(site, VINTED_PATHS.edit(id)));
  if (page.status() === 404) return 'missing';
  return (await appears(page, UPLOAD_FORM.price, APPEAR_MS)) ? 'editing' : 'not_editable';
}

/**
 * Fills the whole upload form from the payload (photos only on a new listing: `files`), or says
 * why the form can't take it. Nothing is sent.
 */
export async function fillUploadForm(
  page: PageDriver,
  payload: VintedListingPayload,
  sku: string,
  files: readonly UploadFile[],
): Promise<FillProblem | null> {
  if (payload.category === null) throw new Error('a Vinted listing has a category');
  await addPhotos(page, files);
  await awaitElement(page, UPLOAD_FORM.title, FORM, 'title');
  await page.fill(UPLOAD_FORM.title, payload.title);
  await awaitElement(page, UPLOAD_FORM.description, FORM, 'description');
  await page.fill(UPLOAD_FORM.description, withSkuLine(payload.description, sku));
  await pickCategory(page, payload.category);
  // The fields the category asks for come with Vinted's answer for it; every category asks a
  // condition, so its field says they are there.
  await awaitElement(page, UPLOAD_FORM.condition.input, FORM, "category's condition field");
  await pickBrand(page, payload.brand);
  const size = await pickSize(page, payload.size);
  if (size !== null) return size;
  if (payload.condition === null) throw new Error('a Vinted listing has a condition');
  await pickOne(page, UPLOAD_FORM.condition, payload.condition, 'condition');
  await pickColors(page, payload.colors);
  if (!(await pickPackageSize(page, payload.packageSize))) return { type: 'package_size_required' };
  await fillPrice(page, payload.price.amountCents);
  return null;
}

/** Fills only the price (an edit page's price change). */
export async function fillPrice(page: PageDriver, priceCents: number): Promise<void> {
  await awaitElement(page, UPLOAD_FORM.price, FORM, 'price');
  await page.fill(UPLOAD_FORM.price, priceField(priceCents));
}

/**
 * Uploads (Upload, or Save on the edit page), then waits for Vinted's answer: its messages under
 * the fields it refuses, or the listing's page. A form that shows neither in time is one Listora
 * no longer understands: the change may have been sent, so a read-back decides.
 */
export async function submitUploadForm(page: PageDriver): Promise<Submitted> {
  await awaitElement(page, UPLOAD_FORM.save, FORM, 'Upload button');
  const start = new URL(page.url()).pathname;
  await page.click(UPLOAD_FORM.save);
  const end = Date.now() + ANSWER_MS;
  for (;;) {
    const path = new URL(page.url()).pathname;
    const itemId = itemIdFromPath(path);
    if (itemId !== null) return { type: 'posted', itemId };
    const messages = (await page.texts(UPLOAD_FORM.error))
      .map((text) => text.replace(/\s+/g, ' ').trim())
      .filter((text) => text !== '');
    if (messages.length > 0) return { type: 'refused', message: [...new Set(messages)].join(' ') };
    // Left the form for a page that doesn't name the listing (the seller's wardrobe).
    if (path !== start) return { type: 'posted', itemId: null };
    if (Date.now() >= end) throw changed(FORM, 'showed no listing and no message after Upload');
    await lookAgain(page, LOOK_EVERY_MS);
  }
}

/** A price for Vinted's field: dollars, with cents only when there are any (`45`, `12.50`). */
export function priceField(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? String(dollars) : `${String(dollars)}.${String(rest).padStart(2, '0')}`;
}

async function addPhotos(page: PageDriver, files: readonly UploadFile[]): Promise<void> {
  if (files.length === 0) return;
  await awaitElement(page, UPLOAD_FORM.photos, FORM, 'photo input');
  await page.upload(UPLOAD_FORM.photos, files);
  // Every photo shows once Vinted took it; one it didn't take is a photo the listing would lack.
  const end = Date.now() + PHOTOS_MS;
  while ((await page.count(UPLOAD_FORM.photo)) < files.length) {
    if (Date.now() >= end) {
      throw changed(
        FORM,
        `showed ${String(await page.count(UPLOAD_FORM.photo))} of ${String(files.length)} photos`,
      );
    }
    await lookAgain(page, LOOK_EVERY_MS);
  }
}

/** Picks the category level by level, down to the one without subcategories it names. */
async function pickCategory(page: PageDriver, path: readonly string[]): Promise<void> {
  const { input, list } = UPLOAD_FORM.category;
  await awaitElement(page, input, FORM, 'category field');
  await page.click(input);
  for (const [level, name] of path.entries()) {
    const row = option(list, name);
    if (!(await appears(page, row, APPEAR_MS))) {
      throw changed(FORM, `offers no category level ${String(level + 1)} "${name}"`);
    }
    await page.click(row);
  }
  // A category without subcategories closes the list; one with them would open its own.
  const end = Date.now() + APPEAR_MS;
  while (await page.exists(list)) {
    if (Date.now() >= end) throw changed(FORM, 'kept its category list open after the category');
    await lookAgain(page, LOOK_EVERY_MS);
  }
}

/**
 * Picks the item's brand from Vinted's list, matched by name ignoring case and punctuation
 * (`Levi's` is Vinted's `Levi’s`), or Vinted's "No brand" when it lists none or the item has none.
 */
async function pickBrand(page: PageDriver, brand: string | null): Promise<void> {
  const { input, list } = UPLOAD_FORM.brand;
  // A category without brands (home goods, books) has no brand field.
  if (!(await page.exists(input))) return;
  for (const wanted of brand === null ? [UPLOAD_FORM.noBrand] : [brand, UPLOAD_FORM.noBrand]) {
    await page.click(input);
    // Pasted, as a search: whatever the field held before is replaced.
    await page.fill(input, wanted);
    if (!(await appears(page, list, APPEAR_MS))) throw changed(FORM, 'shows no brand list');
    const shown = await listed(page, list);
    const match = shown.find((name) => brandKey(name) === brandKey(wanted));
    if (match !== undefined) {
      await page.click(option(list, match));
      return;
    }
  }
  throw changed(FORM, `offers no "${UPLOAD_FORM.noBrand}" brand`);
}

/** Picks the item's size where the form asks one; a problem when the item's isn't offered. */
async function pickSize(page: PageDriver, size: string | null): Promise<FillProblem | null> {
  const { input, list } = UPLOAD_FORM.size;
  if (!(await page.exists(input))) return null;
  await page.click(input);
  if (!(await appears(page, list, APPEAR_MS))) throw changed(FORM, 'shows no size list');
  const offered = await listed(page, list);
  const match = size === null ? undefined : matchSize(offered, size);
  if (match === undefined) {
    // Close the list again: nothing is sent, and the form is left as it was.
    await page.click(input);
    return { type: 'size_not_offered', size, offered: offered.slice(0, 6) };
  }
  await page.click(option(list, match));
  return null;
}

async function pickOne(
  page: PageDriver,
  field: { input: string; list: string },
  name: string,
  what: string,
): Promise<void> {
  await awaitElement(page, field.input, FORM, `${what} field`);
  await page.click(field.input);
  const row = option(field.list, name);
  if (!(await appears(page, row, APPEAR_MS))) throw changed(FORM, `offers no ${what} "${name}"`);
  await page.click(row);
}

/** Ticks up to two colours in Vinted's list, then closes it; a category without colours has none. */
async function pickColors(page: PageDriver, colors: readonly string[]): Promise<void> {
  const { input, list } = UPLOAD_FORM.color;
  if (colors.length === 0 || !(await page.exists(input))) return;
  await page.click(input);
  for (const color of colors) {
    const row = option(list, color);
    if (!(await appears(page, row, APPEAR_MS))) throw changed(FORM, `offers no colour "${color}"`);
    await page.click(row);
  }
  if (await page.exists(list)) await page.click(input);
}

/**
 * Keeps the package size Vinted recommends, or picks the one the listing names; `false` when
 * the form has none chosen and the listing names none (the seller picks it).
 */
async function pickPackageSize(page: PageDriver, size: VintedPackageSize | null): Promise<boolean> {
  if (size !== null) {
    const choice = UPLOAD_FORM.packageSize(size);
    if (!(await page.exists(choice))) throw changed(FORM, `offers no ${size} package size`);
    await page.check(choice, true);
    return true;
  }
  return page.exists(UPLOAD_FORM.packageSizeChosen);
}

/** The names a list shows, each once, in its order. */
async function listed(page: PageDriver, list: string): Promise<string[]> {
  const texts = await page.texts(`${list} *`);
  const names = texts.map((text) => text.replace(/\s+/g, ' ').trim()).filter((text) => text !== '');
  return [...new Set(names)];
}

function brandKey(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\band\b/g, '&')
    .replace(/[^a-z0-9&]/g, '');
}

function sizeKey(label: string): string {
  return label.toLowerCase().replace(/\s+/g, '');
}

/**
 * The size list's label for the item's size: the label itself, else one that starts with it
 * before Vinted's other names for it (`M` is `M / 38 / 10`, `10` is `10 (EU 41)`).
 */
function matchSize(offered: readonly string[], size: string): string | undefined {
  const wanted = sizeKey(size);
  return (
    offered.find((label) => sizeKey(label) === wanted) ??
    offered.find((label) => sizeKey(label.split(/\s*[/(|]\s*/)[0] ?? '') === wanted)
  );
}

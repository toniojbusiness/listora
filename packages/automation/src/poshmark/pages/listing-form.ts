/**
 * Poshmark's listing form: `/create-listing` for a new listing and `/edit-listing/<id>` for a
 * change (the same form, filled in). Every selector the adapter uses on it is here, so a change
 * to Poshmark's form is fixed in this one file.
 *
 * Read in Poshmark's own public listing-editor code (2026-10-26): the form's text inputs are
 * named by their validation names (`data-vv-name`: `title`, `description`, `originalPrice`,
 * `inputPrice` for the listing price, `sku`), the photos input is `#img-file-input`, and a new
 * listing is published in two steps, Next (`data-et-name="next"`) and then List on the share
 * step (`data-et-name="list"`), while a change is saved with Update (`data-et-name="update"`).
 * Poshmark's validation messages are `.form__error-message`. The pickers (catalog, size,
 * condition, availability) and the brand field are Listora's model still, confirmed on a real
 * session from the evidence a stopped run logs. A selector that no longer matches ends the step
 * as `element_missing` before anything is submitted, so the step goes to the user. The fake
 * Poshmark (fake/) mirrors exactly what this file expects.
 *
 * Only `submit` changes anything: filling the form is not saved until it is submitted.
 */
import { PageChangedError } from '../../runner/errors.ts';
import type { PageDriver, UploadFile } from '../../runner/types.ts';
import type { PoshmarkCatalog } from '../catalog.ts';
import type { PoshmarkCondition } from '../conditions.ts';
import type { PoshmarkListingPayload } from '../payload.ts';
import type { PoshmarkSize } from '../sizes.ts';

/** How a listing is offered: for sale, or kept in the closet as not for sale. */
export type Availability = 'for_sale' | 'not_for_sale';

const AVAILABILITY_LABELS = {
  for_sale: 'For Sale',
  not_for_sale: 'Not For Sale',
} as const satisfies Record<Availability, string>;

export const FORM_SELECTORS = {
  /** The form is there once its title field is: Poshmark's scripts draw it. */
  form: 'input[data-vv-name="title"]',
  photos: 'input#img-file-input[type="file"]',
  title: 'input[data-vv-name="title"]',
  description: 'textarea[data-vv-name="description"]',
  brand: 'input[data-vv-name="brand"]',
  originalPrice: 'input[data-vv-name="originalPrice"]',
  /** The listing price (the suggested-price dialog's own field is `inputMinimumPrice`). */
  listingPrice: 'input[data-vv-name="inputPrice"]:not([name="inputMinimumPrice"])',
  sku: 'input[data-vv-name="sku"]',
  /** A picker: `[data-test="<name>"]`, opened by its summary, with labeled choices. */
  picker: (name: Picker) => `details[data-test="${name}"]`,
  choice: (list: string, text: string) => `[data-test="${list}"] label:text-is("${quote(text)}")`,
  /** Goes on from a new listing's form to its share step. */
  next: 'button[data-et-name="next"]',
  /** Publishes a new listing, on the share step. */
  list: 'button[data-et-name="list"]',
  /** Saves a change to a listing. */
  update: 'button[data-et-name="update"]',
  /** Poshmark's own validation messages on the form. */
  errors: '.form__error-message',
} as const;

type Picker = 'catalog' | 'size' | 'condition' | 'availability';

/**
 * Opens a form and waits until it is there; `false` for a listing Poshmark has no form for (a
 * 404). A form that never comes is a page Listora no longer understands (`PageChangedError`).
 */
export async function openForm(page: PageDriver, url: string): Promise<boolean> {
  await page.goto(url);
  if (page.status() === 404) return false;
  try {
    await page.waitFor(FORM_SELECTORS.form, 'attached');
  } catch {
    if (!(await page.exists(FORM_SELECTORS.form))) {
      throw new PageChangedError("Poshmark's listing form has no title field");
    }
  }
  return true;
}

/** Adds the photos in posting order; the first is the cover. */
export async function addPhotos(page: PageDriver, photos: readonly UploadFile[]): Promise<void> {
  await page.upload(FORM_SELECTORS.photos, photos);
}

/** Title, description, brand, and prices. On the edit form this replaces what the listing had. */
export async function fillText(page: PageDriver, payload: PoshmarkListingPayload): Promise<void> {
  await page.fill(FORM_SELECTORS.title, payload.title);
  await page.fill(FORM_SELECTORS.description, payload.description);
  await page.fill(FORM_SELECTORS.brand, payload.brand ?? '');
  await page.fill(
    FORM_SELECTORS.originalPrice,
    payload.originalPrice === null ? '' : wholeDollars(payload.originalPrice.amountCents),
  );
  await setPrice(page, payload.price.amountCents);
}

/** The department, category, and (when the form offers it) subcategory. */
export async function chooseCatalog(page: PageDriver, catalog: PoshmarkCatalog): Promise<void> {
  await choose(page, 'catalog', 'catalog-departments', catalog.department);
  await choose(page, 'catalog', 'catalog-categories', catalog.category);
  if (catalog.subcategory !== null) {
    // Poshmark's subcategory is optional: one its form no longer offers is left out.
    const offered = FORM_SELECTORS.choice('catalog-subcategories', catalog.subcategory);
    if (await page.exists(offered)) await page.click(offered);
  }
}

/** The size (its size set first) and the condition. */
export async function chooseSizeAndCondition(
  page: PageDriver,
  size: PoshmarkSize,
  condition: PoshmarkCondition,
): Promise<void> {
  await choose(page, 'size', 'size-sets', size.set);
  await choose(page, 'size', 'size-options', size.size);
  await choose(page, 'condition', 'condition-options', condition.label);
}

/** The seller's private SKU, which only the seller sees (how Listora finds its listings). */
export async function fillSku(page: PageDriver, sku: string): Promise<void> {
  await page.fill(FORM_SELECTORS.sku, sku);
}

export async function setPrice(page: PageDriver, priceCents: number): Promise<void> {
  await page.fill(FORM_SELECTORS.listingPrice, wholeDollars(priceCents));
}

export async function setAvailability(page: PageDriver, availability: Availability): Promise<void> {
  await choose(page, 'availability', 'availability-options', AVAILABILITY_LABELS[availability]);
}

/**
 * Submits the form (the step that changes the listing) and waits for Poshmark's answer: the
 * listing's page, or the form again with Poshmark's validation messages.
 */
export async function submit(
  page: PageDriver,
  button: 'list' | 'update',
): Promise<{ type: 'saved'; path: string } | { type: 'refused'; message: string }> {
  if (button === 'list') {
    // A new listing's Next checks the form and shows the share step, whose List publishes it.
    await page.click(FORM_SELECTORS.next);
    const refused = await refusal(page);
    if (refused !== null) return refused;
  }
  await page.click(FORM_SELECTORS[button]);
  return (await refusal(page)) ?? saved(page);
}

/** Poshmark's validation messages on the form, when it shows any. */
async function refusal(page: PageDriver): Promise<{ type: 'refused'; message: string } | null> {
  const messages = await page.texts(FORM_SELECTORS.errors);
  const message = messages.filter((text) => text !== '').join(' ');
  return message === '' ? null : { type: 'refused', message };
}

/** Waits for the listing's page, where Poshmark goes once it saved the listing. */
async function saved(page: PageDriver): Promise<{ type: 'saved'; path: string }> {
  await page.waitForPath(/^\/listing\//);
  return { type: 'saved', path: new URL(page.url()).pathname };
}

/** The seller's private SKU on the edit form (only its seller sees it). */
export async function privateSku(page: PageDriver): Promise<string | null> {
  const value = await page.attribute(FORM_SELECTORS.sku, 'value');
  return value === null || value.trim() === '' ? null : value.trim();
}

/** Opens a picker unless it is open, then clicks the choice with this text in one of its lists. */
async function choose(page: PageDriver, picker: Picker, list: string, text: string): Promise<void> {
  const selector = FORM_SELECTORS.picker(picker);
  if (!(await page.exists(`${selector}[open]`))) await page.click(`${selector} > summary`);
  await page.click(FORM_SELECTORS.choice(list, text));
}

function wholeDollars(cents: number): string {
  return String(Math.round(cents / 100));
}

function quote(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

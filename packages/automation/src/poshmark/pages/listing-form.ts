/**
 * Poshmark's listing form: `/create-listing` for a new listing and `/edit-listing/<id>` for a
 * change (the same form, filled in). Every selector the adapter uses on it is here, so a change
 * to Poshmark's form is fixed in this one file.
 *
 * Read in Poshmark's own public listing-editor code (2026-10-26) and on the captain's real
 * session (from the evidence of runs that stopped there): the form's text inputs are named by
 * their validation names (`data-vv-name`: `title`, `description`, `originalPrice`,
 * `listingPrice`, `sku`), the photos input is `#img-file-input`, and a new listing is published in
 * two steps, Next (`data-et-name="next"`) and then List on the share step
 * (`data-et-name="list"`), while a change is saved with Update (`data-et-name="update"`). Picking
 * the photos opens Poshmark's cover-photo editor, which keeps them only once its Apply confirms
 * them; the brand is a text field in the brand section, not a `data-vv-name` field. Poshmark's
 * validation messages are `.form__error-message`, always in the page and hidden until they apply.
 * The pickers (catalog, size, condition, availability) are in FORM_SELECTORS. A selector that no
 * longer matches ends the step as `element_missing` before anything is submitted, so the step
 * goes to the user. The fake Poshmark (fake/) mirrors exactly what this file expects.
 *
 * Only `submit` changes anything: filling the form is not saved until it is submitted.
 */
import { z } from 'zod';

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
  brand: '[data-et-name="listingEditorBrandSection"] input[type="text"]',
  originalPrice: 'input[data-vv-name="originalPrice"]',
  /** The listing price, as the form a seller's session shows names it. */
  listingPrice: 'input[data-vv-name="listingPrice"]',
  /**
   * The Listing Price dialog the price field opens (read on the captain's session, 2026-10-26):
   * the price again, Automate Offers (on by default, and then a lowest price is required), the
   * original price, and Done. Listora sets no automatic offers, so it turns them off. This is the
   * dialog while it shows (`modal--in`); it stays in the page once closed.
   */
  priceDialog: '.listing-price-suggestion-modal.modal--in',
  priceDialogPrice: '.listing-price-suggestion-modal #listing-price-modal-listing-price-input',
  priceDialogOriginal: '.listing-price-suggestion-modal #listing-price-modal-original-price-input',
  priceDialogLowest: '.listing-price-suggestion-modal [data-vv-name="inputPrice"]',
  priceDialogOffers: '.listing-price-suggestion-modal label[data-test="toggle-switch"]',
  priceDialogDone: '.listing-price-suggestion-modal button.btn--primary:text-is("Done")',
  /**
   * The cover-photo editor (`.image-edit-modal`, in one of Poshmark's modals) and its Apply, in
   * the modal's footer; the size picker's Done is an `apply` too.
   */
  photoEditor: '.image-edit-modal',
  applyPhoto: '[data-test="modal-footer"] button[data-et-name="apply"]:text-is("Apply")',
  /**
   * The pickers, from Poshmark's listing-editor code (2026-10-26): each a dropdown opened by its
   * `.dropdown__selector`. The catalog lists departments, then the chosen department's
   * categories, then opens the subcategory dropdown; the size dropdown has a tab per size set,
   * a button per size, and Done; the condition dropdown has an item per condition.
   */
  categorySelector: '.listing-editor__category-container .dropdown__selector',
  department: (name: string) =>
    `.listing-editor__category-container a.dropdown__menu__item:text-is("${quote(name)}")`,
  category: (name: string) =>
    `.listing-editor__category-container li.dropdown__menu__item:text-is("${quote(name)}")`,
  subcategory: (name: string) =>
    `.listing-editor__subcategory-container a[data-et-name="sub_category"]:text-is("${quote(name)}")`,
  sizeSelector: '[data-test="size"]',
  sizeSet: (name: string) =>
    `[data-test="horizontal-list"] li.navigation--horizontal__tab span:text-is("${quote(name)}")`,
  size: (name: string) => `button.multi-size-selector__button:text-is("${quote(name)}")`,
  sizeDone: 'button[data-et-name="apply"][data-et-on-name="multi_item_quantity_tile"]',
  conditionSelector: '.listing-editor__condition-container .dropdown__selector',
  condition: (title: string) =>
    `div[data-et-name="listing_condition"] > div.fw--med:text-is("${quote(title)}")`,
  sku: 'input[data-vv-name="sku"]',
  /** "Additional Details (PRIVATE)", which holds the SKU, shown by its "show details" link. */
  privateDetailsToggle:
    '.listing-editor__toggle:has([data-vv-name="sku"]) a.listing-editor-toggle-link',
  availabilitySelector: '[data-et-name="listingEditorAvailabilitySection"] .dropdown__selector',
  availability: (code: string) =>
    `[data-et-name="listingEditorAvailabilitySection"] a.dropdown__link[data-et-name="${code}"]`,
  /** Goes on from a new listing's form to its share step. */
  next: 'button[data-et-name="next"]',
  /** Publishes a new listing, on the share step. */
  list: 'button[data-et-name="list"]',
  /** Saves a change to a listing. */
  update: 'button[data-et-name="update"]',
  /**
   * Poshmark's own validation messages on the form that show. The form keeps every message in
   * the page and hides the ones that don't apply (`style="display: none;"`, Vue's v-show).
   */
  errors: '.form__error-message:not([style*="display: none"])',
} as const;

/** Poshmark's own names of the availabilities, which its picker's items carry. */
const AVAILABILITY_CODES = {
  for_sale: 'available',
  not_for_sale: 'not_for_sale',
} as const satisfies Record<Availability, string>;

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

/** How long the cover-photo editor gets to open after the photos are picked. */
const EDITOR_OPENS_MS = 6_000;
const LOOK_EVERY_MS = 500;

/**
 * Adds the photos in posting order; the first is the cover. Poshmark's cover-photo editor opens
 * on them, and they are kept once its Apply confirms the cover as it is.
 */
export async function addPhotos(page: PageDriver, photos: readonly UploadFile[]): Promise<void> {
  await expectField(page, FORM_SELECTORS.photos, 'photo input');
  await page.upload(FORM_SELECTORS.photos, photos);
  const end = Date.now() + EDITOR_OPENS_MS;
  while (!(await page.exists(FORM_SELECTORS.photoEditor))) {
    if (Date.now() >= end) return;
    await new Promise((resolve) => setTimeout(resolve, LOOK_EVERY_MS));
  }
  const applies = await page.count(FORM_SELECTORS.applyPhoto);
  if (applies !== 1) {
    throw new PageChangedError(
      `Poshmark's cover-photo editor has ${String(applies)} Apply buttons, not one`,
    );
  }
  await page.click(FORM_SELECTORS.applyPhoto);
  await page.waitFor(FORM_SELECTORS.photoEditor, 'detached');
}

/** Title and description. On the edit form this replaces what the listing had. */
export async function fillText(page: PageDriver, payload: PoshmarkListingPayload): Promise<void> {
  await expectField(page, FORM_SELECTORS.title, 'title field');
  await page.fill(FORM_SELECTORS.title, payload.title);
  await expectField(page, FORM_SELECTORS.description, 'description field');
  await page.fill(FORM_SELECTORS.description, payload.description);
}

/**
 * The listing price, and the original price when the listing has one (the form keeps that
 * field folded away until it is asked for, and it starts empty).
 */
export async function fillPrices(page: PageDriver, payload: PoshmarkListingPayload): Promise<void> {
  await setPrice(page, payload.price.amountCents, payload.originalPrice?.amountCents ?? null);
}

/** The brand, typed into the brand field (Poshmark takes a brand its suggestions don't list). */
export async function fillBrand(page: PageDriver, brand: string | null): Promise<void> {
  if (brand === null) return;
  await expectField(page, FORM_SELECTORS.brand, 'brand field');
  await page.fill(FORM_SELECTORS.brand, brand);
}

/** A field the form must have; without it the step ends at once, before anything is sent. */
async function expectField(page: PageDriver, selector: string, what: string): Promise<void> {
  if (!(await page.exists(selector))) {
    throw new PageChangedError(`Poshmark's listing form has no ${what} (${selector})`);
  }
}

/** The department, category, and (when the form offers it) subcategory. */
export async function chooseCatalog(page: PageDriver, catalog: PoshmarkCatalog): Promise<void> {
  await expectField(page, FORM_SELECTORS.categorySelector, 'category picker');
  await page.click(FORM_SELECTORS.categorySelector);
  await pick(
    page,
    FORM_SELECTORS.department(catalog.department),
    `department "${catalog.department}"`,
  );
  await pick(page, FORM_SELECTORS.category(catalog.category), `category "${catalog.category}"`);
  if (catalog.subcategory !== null) {
    // Poshmark's subcategory is optional: one its form no longer offers is left out.
    const offered = FORM_SELECTORS.subcategory(catalog.subcategory);
    if (await appears(page, offered)) await page.click(offered);
  }
}

/** The size (its size set first) and the condition. */
export async function chooseSizeAndCondition(
  page: PageDriver,
  size: PoshmarkSize,
  condition: PoshmarkCondition,
): Promise<void> {
  await expectField(page, FORM_SELECTORS.sizeSelector, 'size picker');
  await page.click(FORM_SELECTORS.sizeSelector);
  const set = FORM_SELECTORS.sizeSet(size.set);
  // A category with one size set may show no tabs.
  if (await appears(page, set)) await page.click(set);
  await pick(page, FORM_SELECTORS.size(size.size), `size "${size.size}"`);
  // A single item's size applies on the click and closes the picker; Done is for several sizes.
  const shown = (await page.text(FORM_SELECTORS.sizeSelector))?.replace(/\s+/g, ' ').trim();
  if (shown !== size.size) await pick(page, FORM_SELECTORS.sizeDone, 'size Done button');
  await expectField(page, FORM_SELECTORS.conditionSelector, 'condition picker');
  await page.click(FORM_SELECTORS.conditionSelector);
  const title = CONDITION_TITLES[condition.code];
  await pick(page, FORM_SELECTORS.condition(title), `condition "${title}"`);
}

/** The titles the condition picker shows (Poshmark's `listingEditor.condition.dropdownOptions`). */
const CONDITION_TITLES = {
  nwt: 'New With Tags',
  uln: 'Like New',
  ug: 'Good',
  uf: 'Fair',
} as const satisfies Record<PoshmarkCondition['code'], string>;

/** Waits briefly for a choice the page draws once its picker opens, then clicks it. */
async function pick(page: PageDriver, selector: string, what: string): Promise<void> {
  if (!(await appears(page, selector))) {
    throw new PageChangedError(`Poshmark's listing form offers no ${what}`);
  }
  await page.click(selector);
}

/** Whether `selector` is on the page within a moment (a picker's menu draws itself). */
async function appears(page: PageDriver, selector: string): Promise<boolean> {
  const end = Date.now() + EDITOR_OPENS_MS;
  for (;;) {
    if (await page.exists(selector)) return true;
    if (Date.now() >= end) return false;
    await new Promise((resolve) => setTimeout(resolve, LOOK_EVERY_MS));
  }
}

/** The seller's private SKU, which only the seller sees (how Listora finds its listings). */
export async function fillSku(page: PageDriver, sku: string): Promise<void> {
  await expectField(page, FORM_SELECTORS.sku, 'SKU field');
  const toggle = await page.text(FORM_SELECTORS.privateDetailsToggle);
  if (toggle?.trim().toLowerCase() === 'show details') {
    await page.click(FORM_SELECTORS.privateDetailsToggle);
  }
  await page.fill(FORM_SELECTORS.sku, sku);
}

/**
 * Sets the listing price (and the original price, when given) through the price field and the
 * Listing Price dialog it opens: the price, Automate Offers off, the original price, Done.
 */
export async function setPrice(
  page: PageDriver,
  priceCents: number,
  originalCents: number | null = null,
): Promise<void> {
  await expectField(page, FORM_SELECTORS.listingPrice, 'listing price field');
  await page.fill(FORM_SELECTORS.listingPrice, wholeDollars(priceCents));
  if (!(await appears(page, FORM_SELECTORS.priceDialog))) {
    // A form without the dialog takes both prices in its own fields.
    if (originalCents !== null) {
      await expectField(page, FORM_SELECTORS.originalPrice, 'original price field');
      await page.fill(FORM_SELECTORS.originalPrice, wholeDollars(originalCents));
    }
    return;
  }
  await expectField(page, FORM_SELECTORS.priceDialogPrice, 'Listing Price dialog price');
  await page.fill(FORM_SELECTORS.priceDialogPrice, wholeDollars(priceCents));
  if (await page.exists(FORM_SELECTORS.priceDialogLowest)) {
    await page.click(FORM_SELECTORS.priceDialogOffers);
    if (!(await disappears(page, FORM_SELECTORS.priceDialogLowest))) {
      throw new PageChangedError("Poshmark's Listing Price dialog kept Automate Offers on");
    }
  }
  if (originalCents !== null) {
    await expectField(
      page,
      FORM_SELECTORS.priceDialogOriginal,
      'Listing Price dialog original price',
    );
    await page.fill(FORM_SELECTORS.priceDialogOriginal, wholeDollars(originalCents));
  }
  await pick(page, FORM_SELECTORS.priceDialogDone, 'Listing Price dialog Done button');
  if (!(await disappears(page, FORM_SELECTORS.priceDialog))) {
    throw new PageChangedError("Poshmark's Listing Price dialog didn't close on Done");
  }
}

/** Whether `selector` is gone from the page within a moment. */
async function disappears(page: PageDriver, selector: string): Promise<boolean> {
  const end = Date.now() + EDITOR_OPENS_MS;
  for (;;) {
    if (!(await page.exists(selector))) return true;
    if (Date.now() >= end) return false;
    await new Promise((resolve) => setTimeout(resolve, LOOK_EVERY_MS));
  }
}

export async function setAvailability(page: PageDriver, availability: Availability): Promise<void> {
  await expectField(page, FORM_SELECTORS.availabilitySelector, 'availability picker');
  const shown = await page.text(FORM_SELECTORS.availabilitySelector);
  if (shown?.replace(/\s+/g, ' ').trim() === AVAILABILITY_LABELS[availability]) return;
  await page.click(FORM_SELECTORS.availabilitySelector);
  await pick(
    page,
    FORM_SELECTORS.availability(AVAILABILITY_CODES[availability]),
    `availability "${AVAILABILITY_LABELS[availability]}"`,
  );
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

/**
 * Waits for where Poshmark goes once it saved the listing: the listing's page, or (read on the
 * captain's session, 2026-10-26: after List on a new listing) the seller's closet.
 */
async function saved(page: PageDriver): Promise<{ type: 'saved'; path: string }> {
  await page.waitForPath(/^\/(listing|closet)\//);
  return { type: 'saved', path: new URL(page.url()).pathname };
}

/** The seller's private SKU on the edit form (only its seller sees it). */
export async function privateSku(page: PageDriver): Promise<string | null> {
  // Read on the captain's session (2026-10-26): the form's field has no value attribute (Vue
  // sets the value itself); the edit form's data holds it at
  // `$_listing_editor.post.seller_private_info.sku`.
  const state = await page.pageData('__INITIAL_STATE__');
  const parsed = editorSkuSchema.safeParse(state);
  const fromState = parsed.success
    ? (parsed.data.$_listing_editor.post.seller_private_info.sku ?? null)
    : null;
  const value = fromState ?? (await page.attribute(FORM_SELECTORS.sku, 'value'));
  return value === null || value.trim() === '' ? null : value.trim();
}

const editorSkuSchema = z.object({
  $_listing_editor: z.object({
    post: z.object({
      seller_private_info: z.object({ sku: z.string().nullable().optional() }),
    }),
  }),
});

function wholeDollars(cents: number): string {
  return String(Math.round(cents / 100));
}

function quote(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

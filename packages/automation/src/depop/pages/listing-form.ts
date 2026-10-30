/**
 * Depop's listing form: the sell page (`/products/create/`) for a new listing, and the same form
 * on a listing's edit page (`/products/edit/<slug>/`). Filling it changes nothing; only
 * submitting it does.
 *
 * The form, in the order the script fills it: the description (the whole listing text: copy,
 * Listora's SKU line, hashtags; Depop listings have no title), the category (searched for, and
 * picked in its group, headed by department and category), size (from the product type's size
 * list), brand (typed into Depop's brand search and picked from its suggestions; without an
 * exact suggestion the listing is posted without a brand, since the form takes only brands from
 * its own list), condition, colours and material, the price in dollars and cents, Boost off, and
 * last the photos (one file input, in posting order, the first the cover), so Depop's own fill
 * from them finds Listora's values in place (docs/features/depop-automation.md, "Filling the
 * form"). Shipping is left as the seller set it up on Depop: the form starts with the seller's
 * own shipping choice, and a seller with none gets Depop's own message asking for one (a
 * rejection the user can fix).
 *
 * After submitting, the form either shows Depop's validation message (a rejection in Depop's own
 * words) or opens the product's page (`/products/<slug>/`, where Depop shows a new listing).
 */
import type { PageDriver, UploadFile } from '../../runner/types.ts';
import { depopListingText, depopPriceField, type DepopAutomationPayload } from '../payload.ts';
import { DEPOP_PATHS, slugFromPath } from '../site.ts';
import { sizeOptionMatches } from '../sizes.ts';
import {
  absolute,
  awaitElement,
  changed,
  expectElement,
  lookAgain,
  type DepopSite,
} from './common.ts';

/**
 * Read on a real session (2026-10-26, from the evidence a stopped run logs): the sell page is
 * drawn by Depop's scripts, with the photos input `#upload-input__input`, the description
 * `textarea#description`, the price `#priceAmount__input`, and its pickers as comboboxes, each
 * an input, a toggle button, and a menu of options (`#group-` for the category, `#brand-`,
 * `#condition-`, `#colour-`, `#variants-` for the size, `#attributes.material-`, ...). Confirmed
 * on every form shape on the captain's session (2026-10-27).
 */
export const LISTING_FORM = {
  /** The form is there once its description field is. */
  form: 'textarea#description',
  photos: 'input#upload-input__input[type="file"]',
  description: 'textarea#description',
  price: 'input#priceAmount__input',
  post: 'button[type="submit"]:text-is("Post")',
  /** The edit page's submit (read on the seller's session, 2026-10-27). */
  save: 'button[type="submit"]:text-is("Save changes")',
  /** "Post and add another": checked, Depop opens a new empty form instead of the listing. */
  postAnother: 'input#post-another[type="checkbox"]',
  error: '[role="alert"]',
  /** A field Depop marks as needing a fix. */
  invalid: '[aria-invalid="true"]',
  clearBrand: 'button[data-testid="brandButton__clear"]',
  clearCategory: 'button[data-testid="groupButton__clear"]',
  /**
   * "Boost your listing" (an extra 12% fee when it sells): Listora never turns it on. Read on
   * the captain's session (2026-10-27): the form's only switch.
   */
  boost: 'input[data-testid="switch"][type="checkbox"]',
  /**
   * An added photo, once Depop has it: its preview from Depop's own image server (read on the
   * captain's session, 2026-10-27, about 3 seconds after adding three).
   */
  photoPreview: 'div[role="button"] > img[src]',
} as const;

/** Depop's Done page after a post: under the sell page's path, with one more segment. */
const DONE_PAGE = /^\/products\/create\/([^/]+)\/?$/;

/** How long Depop gets to answer a Post (its photos upload first), and how often it is looked at. */
const ANSWER_MS = 45_000;
// A look only reads the page (no action, so no pacing): a short interval loses less time
// after the element appears.
const LOOK_EVERY_MS = 150;

/**
 * One of Depop's combobox pickers (`group` is the category, `variants` the size). Its menu keeps
 * its options while closed and shows them through a style variable (`--display: block`), so
 * options are only clicked in an open menu.
 */
function combo(name: string) {
  // By attribute: item specifics' ids have a dot (`attributes.material-menu`).
  const open = `ul[id="${name}-menu"][style*="--display: block"]`;
  return {
    input: `input[id="${name}-input"]`,
    toggle: `button[id="${name}-toggle-button"]`,
    open,
    option: (text: string) => `${open} [role="option"]:text-is("${text.replaceAll('"', '\\"')}")`,
    anyOption: `${open} [role="option"]`,
    /** A multi-value picker's picked values, each shown with its own "Remove <value>". */
    picked: `div:has(> input[id="${name}-input"]) button[aria-label^="Remove "]`,
    unpick: (text: string) =>
      `div:has(> input[id="${name}-input"]) button[aria-label="Remove ${text.replaceAll('"', '\\"')}"]`,
  } as const;
}

const FORM = 'listing form';

/** Opens the sell page's empty form. */
export async function openSellForm(page: PageDriver, site: DepopSite): Promise<void> {
  await page.goto(absolute(site, DEPOP_PATHS.sell));
  // Drawn by the site's own scripts once the document is ready.
  await awaitElement(page, LISTING_FORM.form, 'sell page', FORM);
}

/**
 * Fills the whole form from the payload, with the SKU line in the text. `photos` are uploaded
 * in the order given; `null` leaves the listing's photos as they are (an edit).
 */
export async function fillListing(
  page: PageDriver,
  payload: DepopAutomationPayload,
  sku: string,
  photos: readonly UploadFile[] | null,
): Promise<void> {
  await awaitElement(page, LISTING_FORM.form, FORM, FORM);
  await page.fill(LISTING_FORM.description, depopListingText(payload, sku));
  let brand = await fillPicks(page, payload);
  await fillPrice(page, payload.price.amountCents);
  // Depop's own SKU field stays empty: Depop takes a SKU once only, even after the listing is
  // deleted (a relist under it is refused), so Listora finds its listings by the SKU line.
  await noBoost(page);
  if (photos !== null) {
    // Last: Depop fills in item info from the photos ("Item info added"), and its fill takes
    // only fields still empty, so Listora's are in place first. Drawn with the rest of the
    // form, a moment after its description field.
    await awaitElement(page, LISTING_FORM.photos, FORM, 'photo input');
    await page.upload(LISTING_FORM.photos, photos);
    await photosAdded(page, photos.length);
    await lookAgain(page, PHOTO_FILL_MS);
    // Depop's fill may still have taken a field over: Listora's values are put back once.
    if ((await mismatch(page, payload, brand)) !== null) brand = await fillPicks(page, payload);
  }
  await expectPicked(page, payload, brand);
  await expectComplete(page);
}

/** How long Depop gets to fill in item info from the photos once they are added. */
const PHOTO_FILL_MS = 1_500;
/** How long Depop gets to take the photos (it uploads them to its image server first). */
const PHOTOS_MS = 30_000;

/** Waits until Depop shows every photo as added: Post refuses a form whose photos are still going. */
async function photosAdded(page: PageDriver, count: number): Promise<void> {
  if (
    !(await appears(page, `${LISTING_FORM.photoPreview} >> nth=${String(count - 1)}`, PHOTOS_MS))
  ) {
    const shown = await page.count(LISTING_FORM.photoPreview);
    throw changed(FORM, `shows ${String(shown)} of ${String(count)} photos as added`);
  }
}

/** The category and every picker the payload fills; the brand the form then shows. */
async function fillPicks(page: PageDriver, payload: DepopAutomationPayload): Promise<string> {
  if (payload.category === null) throw new Error('a listing without a category passed validation');
  await pickCategory(page, payload.category);
  if (payload.size !== null) await pickSize(page, payload.size);
  const brand = await pickBrand(page, payload.brand);
  if (payload.condition === null) {
    throw new Error('a listing without a condition passed validation');
  }
  await pick(page, 'condition', payload.condition.label, `condition "${payload.condition.label}"`);
  for (const detail of payload.details ?? []) await pickAll(page, detail.field, detail.values);
  return brand;
}

/** Turns "Boost your listing" off when Depop drew it on. */
async function noBoost(page: PageDriver): Promise<void> {
  if (!(await page.exists(LISTING_FORM.boost))) return;
  if (await checked(page)) await page.check(LISTING_FORM.boost, false);
}

async function checked(page: PageDriver): Promise<boolean> {
  return page.exists(`${LISTING_FORM.boost}:checked`);
}

/**
 * The first pick the form no longer shows (one Depop's own fill took over), in words, or
 * `null`. `brand` is the brand Listora picked, `''` for none.
 */
async function mismatch(
  page: PageDriver,
  payload: DepopAutomationPayload,
  brand: string,
): Promise<string | null> {
  const shown = async (name: string) => (await page.value(combo(name).input))?.trim() ?? '';
  // Without a brand of Listora's, one Depop filled in from the photos is its own suggestion, as
  // a seller filling the form by hand gets it, and stays.
  if (brand !== '' && (await shown('brand')) !== brand) return `the brand "${brand}"`;
  const type = payload.category?.[2];
  if (type !== undefined && (await shown('group')) !== type) return `the category "${type}"`;
  if (payload.size !== null && (await shown('variants')) !== payload.size) {
    return `the size "${payload.size}"`;
  }
  if (payload.condition !== null && (await shown('condition')) !== payload.condition.label) {
    return `the condition "${payload.condition.label}"`;
  }
  for (const detail of payload.details ?? []) {
    const picked = await pickedValues(page, detail.field);
    if (picked.length !== detail.values.length || detail.values.some((v) => !picked.includes(v))) {
      return `the ${detail.field} "${detail.values.join(', ')}"`;
    }
  }
  return null;
}

/**
 * The form still shows what Listora picked, and "Boost your listing" is off, just before the
 * step that submits it.
 */
async function expectPicked(
  page: PageDriver,
  payload: DepopAutomationPayload,
  brand: string,
): Promise<void> {
  const missing = await mismatch(page, payload, brand);
  if (missing !== null) throw changed(FORM, `no longer shows ${missing}`);
  if ((await page.exists(LISTING_FORM.boost)) && (await checked(page))) {
    throw changed(FORM, 'keeps "Boost your listing" on');
  }
}

/**
 * Picks exactly these values in one of the form's multi-value pickers (colours, material),
 * leaving out any other value it had (one Depop filled in from the photos). Read on the
 * captain's session (2026-10-27): each picked value shows in the picker with its own "Remove
 * <value>" button, and its option in the menu no longer takes a click.
 */
async function pickAll(page: PageDriver, name: string, values: readonly string[]): Promise<void> {
  const box = combo(name);
  if (!(await page.exists(box.toggle))) throw changed(FORM, `has no ${name} picker`);
  for (const value of await pickedValues(page, name)) {
    if (!values.includes(value)) await page.click(box.unpick(value));
  }
  for (const value of values) {
    if ((await pickedValues(page, name)).includes(value)) continue;
    if (!(await page.exists(box.open))) await page.click(box.toggle);
    await awaitElement(page, box.anyOption, FORM, `${name} options`);
    if (!(await page.exists(box.option(value)))) {
      throw changed(FORM, `offers no ${name} "${value}"`);
    }
    await page.click(box.option(value));
  }
  // Closed again, so the next picker opens on its own.
  if (await page.exists(box.open)) await page.click(box.toggle);
  const picked = await pickedValues(page, name);
  if (picked.length !== values.length || values.some((value) => !picked.includes(value))) {
    throw changed(
      FORM,
      `shows ${name} "${picked.join(', ')}" after picking "${values.join(', ')}"`,
    );
  }
}

/** The values a multi-value picker shows as picked. */
async function pickedValues(page: PageDriver, name: string): Promise<string[]> {
  return (await page.attributes(combo(name).picked, 'aria-label')).flatMap((label) =>
    label === null ? [] : [label.replace(/^Remove /, '').trim()],
  );
}

/**
 * The filled form, before anything is submitted: no field marked as needing a fix and no
 * message, so the submit sends a form Listora understands.
 */
async function expectComplete(page: PageDriver): Promise<void> {
  const invalid = await page.count(LISTING_FORM.invalid);
  if (invalid > 0) {
    throw changed(FORM, `marks ${String(invalid)} filled field(s) as needing a fix`);
  }
  if ((await messages(page)).length > 0) throw changed(FORM, 'shows a message before posting');
}

/**
 * Checks the form has its Post (sell) or Save (edit) button, before the step that submits it
 * starts: that step counts as one that may have changed the listing.
 */
export async function expectSubmit(page: PageDriver, button: 'post' | 'save'): Promise<void> {
  await expectElement(
    page,
    LISTING_FORM[button],
    FORM,
    `${button === 'post' ? 'Post' : 'Save'} button`,
  );
}

/** Fills only the price (a price change on the edit page). */
export async function fillPrice(page: PageDriver, cents: number): Promise<void> {
  await expectElement(page, LISTING_FORM.price, FORM, 'price field');
  await page.fill(LISTING_FORM.price, depopPriceField(cents));
}

export type Submitted =
  /** The form showed Depop's validation message; nothing was posted or saved. */
  | { type: 'refused'; message: string }
  /**
   * Depop took it: it opened the product's page, or its own Done page after a post, which
   * doesn't say the product's slug (`null`; the operation's check finds it by its SKU).
   */
  | { type: 'posted'; slug: string | null };

/**
 * Submits the form with its Post (sell) or Save (edit) button, and waits for Depop's answer:
 * the product's page, or the form again with Depop's message or a field marked as needing a
 * fix. Anything else (a page Listora doesn't know, or no answer in time) leaves the outcome
 * unknown, so the operation's check reads the listing back.
 */
export async function submitListing(page: PageDriver, button: 'post' | 'save'): Promise<Submitted> {
  const selector = LISTING_FORM[button];
  await expectElement(page, selector, FORM, `${button === 'post' ? 'Post' : 'Save'} button`);
  if (button === 'post' && (await page.exists(LISTING_FORM.postAnother))) {
    await page.check(LISTING_FORM.postAnother, false);
  }
  await page.click(selector);
  const end = Date.now() + ANSWER_MS;
  for (;;) {
    const path = new URL(page.url()).pathname;
    const slug = slugFromPath(path);
    if (slug !== null) return { type: 'posted', slug };
    if (button === 'post' && DONE_PAGE.test(path)) {
      // Read on the captain's session (2026-10-26): after Post, Depop opens "Done - Depop" under
      // the sell page's path, with "List another item". It names the product in its path or
      // links to it, so the new listing is known at once.
      const named = DONE_PAGE.exec(path)?.[1];
      return {
        type: 'posted',
        slug:
          (named === undefined ? null : slugFromPath(`/products/${named}/`)) ??
          (await linkedProduct(page)),
      };
    }
    const shown = await messages(page);
    if (shown.length > 0) return { type: 'refused', message: shown.join(' ') };
    if ((await page.count(LISTING_FORM.invalid)) > 0) {
      return {
        type: 'refused',
        message: "Depop didn't take the listing: it marked a field as needing a fix.",
      };
    }
    if (Date.now() >= end) throw changed(FORM, 'showed no product and no message after the submit');
    await lookAgain(page, LOOK_EVERY_MS);
  }
}

/** The product a page links to (the Done page's link to the new listing), when it links one. */
async function linkedProduct(page: PageDriver): Promise<string | null> {
  for (const href of await page.attributes('a[href*="/products/"]', 'href')) {
    if (href === null || !URL.canParse(href, page.url())) continue;
    const slug = slugFromPath(new URL(href, page.url()).pathname);
    if (slug !== null) return slug;
  }
  return null;
}

/** Depop's messages on the form (its alerts with text). */
async function messages(page: PageDriver): Promise<string[]> {
  return (await page.texts(LISTING_FORM.error)).filter((text) => text !== '');
}

/**
 * Picks the category. Read on the captain's session (2026-10-26): the category picker is one
 * searchable list (`ul#group-menu`) of groups, each headed by its department and category
 * ("Men > Tops", "Women > Tops", "Kids > Tops", "Everything else > Home") and holding that
 * category's product types as options ("T-shirts"). The product type is searched for, then
 * picked in its group; a group the list doesn't have stops the step before anything is sent.
 */
async function pickCategory(page: PageDriver, path: readonly string[]): Promise<void> {
  const [department, category, type] = path;
  if (department === undefined || category === undefined || type === undefined) {
    throw new Error('a category path has a department, a category, and a product type');
  }
  const box = combo('group');
  // The edit form starts with the listing's category picked.
  if (await page.exists(LISTING_FORM.clearCategory)) await page.click(LISTING_FORM.clearCategory);
  await expectElement(page, box.input, FORM, 'category search');
  const group = `${FORM_DEPARTMENTS[department] ?? department} > ${category}`;
  // The search matches product types and categories: by the product type first, and by the
  // category when the product type's name is a common one ("Other").
  for (const search of [type, category]) {
    await page.fill(box.input, '');
    await page.type(box.input, search);
    await awaitElement(page, box.anyOption, FORM, 'category options');
    const headers = (await page.texts(CATEGORY_GROUP_HEADERS)).map((text) =>
      text.replace(/\s+/g, ' ').trim(),
    );
    const index = headers.indexOf(group);
    if (index < 0) continue;
    const option = `${CATEGORY_GROUPS} >> nth=${String(index)} >> [role="option"]:text-is("${type.replaceAll('"', '\\"')}")`;
    if ((await page.count(option)) !== 1) {
      throw changed(FORM, `has no one "${type}" in the category group "${group}"`);
    }
    await page.click(option);
    return;
  }
  throw changed(FORM, `has no category group "${group}"`);
}

/** The category picker's groups and their headers ("Men > Tops"), in the same order. */
const CATEGORY_GROUPS = 'ul#group-menu > div';
const CATEGORY_GROUP_HEADERS = 'ul#group-menu > div > div:first-child p';
/** Listora's department names as the category picker heads its groups. */
const FORM_DEPARTMENTS: Readonly<Record<string, string>> = {
  Menswear: 'Men',
  Womenswear: 'Women',
  Kidswear: 'Kids',
};

/** Whether `selector` is on the page within `ms` (a part Depop's scripts draw). */
async function appears(page: PageDriver, selector: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await page.exists(selector)) return true;
    if (Date.now() >= end) return false;
    await lookAgain(page, 500);
  }
}

/** Opens one of the form's comboboxes and picks the option with exactly this text. */
async function pick(page: PageDriver, name: string, text: string, what: string): Promise<void> {
  const box = combo(name);
  await expectElement(page, box.toggle, FORM, `${what} picker`);
  if (!(await page.exists(box.open))) await page.click(box.toggle);
  await awaitElement(page, box.anyOption, FORM, `${what} options`);
  await expectElement(page, box.option(text), FORM, `${what} "${text}"`);
  await page.click(box.option(text));
}

/** How long Depop takes to draw the size picker once a category is picked. */
const SIZE_PICKER_MS = 10_000;

async function pickSize(page: PageDriver, size: string): Promise<void> {
  const box = combo('variants');
  // Depop draws the size picker for the category just picked, a moment after the pick (on the
  // phone once, after Listora had already looked, 2026-10-27).
  if (!(await appears(page, box.toggle, SIZE_PICKER_MS))) {
    throw changed(FORM, `has no size picker (${box.toggle})`);
  }
  if (!(await page.exists(box.open))) await page.click(box.toggle);
  await awaitElement(page, box.anyOption, FORM, 'size options');
  const offered = (await page.texts(box.anyOption)).map((option) => option.trim());
  const label = offered.includes(size)
    ? size
    : offered.find((option) => sizeOptionMatches(option, size));
  if (label === undefined) throw changed(FORM, `offers no size "${size}" for this category`);
  await page.click(box.option(label));
}

/** Searches Depop's brand list and picks the exact brand, or leaves the brand empty. */
/** Picks the brand, or leaves it empty; the brand the form then shows (`''` for none). */
async function pickBrand(page: PageDriver, brand: string | null): Promise<string> {
  const box = combo('brand');
  // A brand Depop filled in from the photos is cleared, so the listing's own is the one kept.
  if (await page.exists(LISTING_FORM.clearBrand)) await page.click(LISTING_FORM.clearBrand);
  await expectElement(page, box.input, FORM, 'brand search');
  if (brand === null) return '';
  await page.type(box.input, brand);
  await awaitElement(page, box.anyOption, FORM, 'brand suggestions');
  const suggestions = (await page.texts(box.anyOption)).map((suggestion) => suggestion.trim());
  const own = brand.toLowerCase();
  // The brand itself, ignoring case; else the one brand Depop lists under its longer name
  // ("PSD Underwear" for PSD).
  const longer = suggestions.filter((suggestion) => suggestion.toLowerCase().startsWith(`${own} `));
  const picked =
    suggestions.find((suggestion) => suggestion.toLowerCase() === own) ??
    (longer.length === 1 ? longer[0] : undefined);
  // Without one the listing goes without a brand: the form takes only its own.
  if (picked === undefined) {
    await page.fill(box.input, '');
    return '';
  }
  await page.click(box.option(picked));
  return picked;
}

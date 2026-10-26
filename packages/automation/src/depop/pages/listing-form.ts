/**
 * Depop's listing form: the sell page (`/products/create/`) for a new listing, and the same form
 * on a listing's edit page (`/products/edit/<slug>/`). Filling it changes nothing; only
 * submitting it does.
 *
 * The form, in the order the script fills it: photos (one file input, in posting order, the
 * first the cover), the description (the whole listing text: copy, Listora's SKU line, hashtags;
 * Depop listings have no title), the category level by level (department, category, product
 * type; each level's options appear once the one above is picked), size (from the product
 * type's size list), brand (typed into Depop's brand search and picked from its suggestions;
 * without an exact suggestion the listing is posted without a brand, since the form takes only
 * brands from its own list), condition, and the price in dollars and cents. Shipping is left as
 * the seller set it up on Depop: the form starts with the seller's own shipping choice, and a
 * seller with none gets Depop's own message asking for one (a rejection the user can fix).
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
 * `#condition-`, `#colour-`, ...). How the category combobox lists Depop's categories, the size
 * picker, the Post button's words, and Depop's validation message are confirmed from the
 * evidence of the next run that reaches them.
 */
export const LISTING_FORM = {
  /** The form is there once its description field is. */
  form: 'textarea#description',
  photos: 'input#upload-input__input[type="file"]',
  description: 'textarea#description',
  price: 'input#priceAmount__input',
  post: 'button[type="submit"]:text-is("Post")',
  save: 'button[type="submit"]:text-is("Save")',
  /** "Post and add another": checked, Depop opens a new empty form instead of the listing. */
  postAnother: 'input#post-another[type="checkbox"]',
  error: '[role="alert"]',
  /** A field Depop marks as needing a fix. */
  invalid: '[aria-invalid="true"]',
} as const;

/** How long Depop gets to answer a Post (its photos upload first), and how often it is looked at. */
const ANSWER_MS = 45_000;
const LOOK_EVERY_MS = 500;

/** One of Depop's combobox pickers (`group` is the category). */
function combo(name: string) {
  return {
    input: `input#${name}-input`,
    toggle: `button#${name}-toggle-button`,
    option: (text: string) =>
      `ul#${name}-menu [role="option"]:text-is("${text.replaceAll('"', '\\"')}")`,
    anyOption: `ul#${name}-menu [role="option"]`,
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
  if (photos !== null) {
    await expectElement(page, LISTING_FORM.photos, FORM, 'photo input');
    await page.upload(LISTING_FORM.photos, photos);
  }
  await page.fill(LISTING_FORM.description, depopListingText(payload, sku));
  if (payload.category === null) throw new Error('a listing without a category passed validation');
  for (const [level, name] of payload.category.entries()) {
    await pick(page, 'group', name, `category level ${String(level + 1)}`);
  }
  if (payload.size !== null) await pickSize(page, payload.size);
  await pickBrand(page, payload.brand);
  if (payload.condition === null) {
    throw new Error('a listing without a condition passed validation');
  }
  await pick(page, 'condition', payload.condition.label, `condition "${payload.condition.label}"`);
  await fillPrice(page, payload.price.amountCents);
  await expectComplete(page);
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
  /** Depop opened the product's page. */
  | { type: 'posted'; slug: string };

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
    const slug = slugFromPath(new URL(page.url()).pathname);
    if (slug !== null) return { type: 'posted', slug };
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

/** Depop's messages on the form (its alerts with text). */
async function messages(page: PageDriver): Promise<string[]> {
  return (await page.texts(LISTING_FORM.error)).filter((text) => text !== '');
}

/** Opens one of the form's comboboxes and picks the option with exactly this text. */
async function pick(page: PageDriver, name: string, text: string, what: string): Promise<void> {
  const box = combo(name);
  await expectElement(page, box.toggle, FORM, `${what} picker`);
  if (!(await page.exists(box.anyOption))) await page.click(box.toggle);
  await awaitElement(page, box.anyOption, FORM, `${what} options`);
  await expectElement(page, box.option(text), FORM, `${what} "${text}"`);
  await page.click(box.option(text));
}

async function pickSize(page: PageDriver, size: string): Promise<void> {
  const box = combo('size');
  await expectElement(page, box.toggle, FORM, 'size picker');
  if (!(await page.exists(box.anyOption))) await page.click(box.toggle);
  await awaitElement(page, box.anyOption, FORM, 'size options');
  const offered = await page.texts(box.anyOption);
  const label = offered.find((option) => sizeOptionMatches(option, size));
  if (label === undefined) throw changed(FORM, `offers no size "${size}" for this category`);
  await page.click(box.option(label));
}

/** Searches Depop's brand list and picks the exact brand, or leaves the brand empty. */
async function pickBrand(page: PageDriver, brand: string | null): Promise<void> {
  const box = combo('brand');
  await expectElement(page, box.input, FORM, 'brand search');
  if (brand === null) return;
  await page.type(box.input, brand);
  await awaitElement(page, box.anyOption, FORM, 'brand suggestions');
  const suggestions = await page.texts(box.anyOption);
  const exact = suggestions.find((suggestion) => suggestion.toLowerCase() === brand.toLowerCase());
  // Without an exact suggestion the listing goes without a brand: the form takes only its own.
  if (exact === undefined) {
    await page.fill(box.input, '');
    return;
  }
  await page.click(box.option(exact));
}

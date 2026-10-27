/**
 * Mercari's listing form: the sell page (`/sell/`) for a new listing, and the same form on a
 * listing's edit page (`/sell/edit/<id>/`). Filling it changes nothing; only submitting it does.
 *
 * The form, in the order the script fills it: photos (one file input, in posting order), title,
 * description (with Listora's SKU line), the category level by level (each level's options
 * appear once the one above is picked), brand (typed into Mercari's brand search and picked from
 * its suggestions; without an exact suggestion the listing is posted without a brand, since the
 * form takes only brands from its own list), condition, size (from the category's size list),
 * shipping (who pays, and the prepaid label's weight), and the whole-dollar price.
 *
 * After submitting, the form either shows Mercari's validation message (a rejection in
 * Mercari's own words) or opens the listing's page.
 */
import type { PageDriver, UploadFile } from '../../runner/types.ts';
import type { MercariListingPayload } from '../payload.ts';
import { withSkuLine } from '../payload.ts';
import { sizeOptionMatches } from '../sizes.ts';
import { itemIdFromPath, MERCARI_PATHS } from '../site.ts';
import {
  absolute,
  awaitElement,
  changed,
  expectElement,
  priceField,
  type MercariSite,
} from './common.ts';

/**
 * Read on the captain's verified session (2026-10-27): the sell page is drawn by Mercari's
 * scripts with no form element; its parts are named by test ids. The category is a dialog of
 * rows level by level ("Men", "Tops", "T-shirts"); brand and size are searchable lists of
 * options; condition is a radio per Mercari condition id (1 New ... 5 Poor). Shipping starts on
 * "Ship on your own": Listora picks Mercari's prepaid label, keeps the label Mercari recommends
 * for the category, and answers "Offer buyers free shipping?" with No (the buyer pays).
 */
export const LISTING_FORM = {
  /** The form is there once its title field is. */
  form: 'input[data-testid="Title"]',
  photos: 'input[type="file"][data-testid="SellPhotoInput"]',
  /** A one-time tip about listing templates, over the form on a seller's first visits. */
  templatesTip: 'button[data-testid="ListingTemplatesEducationGotIt"]',
  title: 'input[data-testid="Title"]',
  description: 'textarea[data-testid="Description"]',
  category: 'button[data-testid="SellCategoryFieldButton"]',
  categoryDialog: '[data-testid="DialogWrapper"]',
  categoryRow: (name: string) =>
    `[data-testid="DialogWrapper"] button[data-testid="CategoryRow"]:text-is("${quote(name)}")`,
  brand: 'input[data-testid="Brand"]',
  brandOption: '[data-testid="Brand-option"]',
  condition: (id: number) => `input[type="radio"][value="${String(id)}"]`,
  size: 'input[data-testid="Size"]',
  sizeOption: '[data-testid="Size-option"]',
  prepaidLabel: 'button[data-testid="MercariShipping"]',
  prepaidLabelChosen: 'input#MERCARI[type="radio"]',
  shippingClass: 'input[data-testid="SelectShipping"]',
  freeShipping: '[data-testid="ShippingPayerOption"]',
  freeShippingNo: 'li[data-testid="FreeShippingNoButton"]',
  price: 'input[data-testid="Price"]',
  /**
   * Smart Pricing (automatic price drops, which want a lowest price), on by default on some
   * sellers' forms (seen on the captain's phone, 2026-10-27). Listora sets no automatic price
   * drops, so it is switched off.
   */
  smartPricing: 'button[data-testid="SmartPricingButton"]',
  /** Its switch asks to confirm turning it off. */
  smartPricingTurnOff: 'button[data-testid="SmartPricingTurnOffButton"]',
  /** Mercari's answer to List from a seller without a card on file: add one first. */
  paymentWarning: '[data-testid="PaymentWarningModal"]',
  list: 'button[data-testid="ListButton"]',
  save: 'button[data-testid="SaveButton"]',
  error: '[data-testid="FormError"]',
} as const;

const FORM = 'listing form';
/** How long a part Mercari's scripts draw gets to appear, and how often it is looked at. */
const APPEAR_MS = 8_000;
const LOOK_EVERY_MS = 500;

/**
 * Mercari's dialog on the sell page for a seller it wants verified first (read 2026-10-26:
 * `VerificationExceptionDialog`, listing the verifications it requires, with a Verify button).
 * Only the seller can do that, in Mercari; Listora never clicks it.
 */
export const VERIFICATION_DIALOG = '[data-testid="VerificationExceptionDialog"]';

/**
 * Opens the sell page's empty form; `verification_required` when Mercari asks the seller to
 * verify their account before they can list.
 */
export async function openSellForm(
  page: PageDriver,
  site: MercariSite,
): Promise<'form' | 'verification_required'> {
  await page.goto(absolute(site, MERCARI_PATHS.sell));
  // Drawn by the site's own scripts once the document is ready.
  await awaitElement(page, `${LISTING_FORM.form}, ${VERIFICATION_DIALOG}`, 'sell page', FORM);
  return (await page.exists(VERIFICATION_DIALOG)) ? 'verification_required' : 'form';
}

/**
 * Fills the whole form from the payload, ending the description with the SKU line. `photos`
 * are uploaded in the order given; `null` leaves the listing's photos as they are (an edit).
 */
export async function fillListing(
  page: PageDriver,
  payload: MercariListingPayload,
  sku: string,
  photos: readonly UploadFile[] | null,
): Promise<void> {
  await expectElement(page, LISTING_FORM.form, FORM, FORM);
  if (await page.exists(LISTING_FORM.templatesTip)) await page.click(LISTING_FORM.templatesTip);
  if (photos !== null) {
    await expectElement(page, LISTING_FORM.photos, FORM, 'photo input');
    await page.upload(LISTING_FORM.photos, photos);
  }
  await expectElement(page, LISTING_FORM.title, FORM, 'title field');
  await page.fill(LISTING_FORM.title, payload.title);
  await expectElement(page, LISTING_FORM.description, FORM, 'description field');
  await page.fill(LISTING_FORM.description, withSkuLine(payload.description, sku));
  if (payload.category === null) throw new Error('a listing without a category passed validation');
  await pickCategory(page, payload.category);
  await pickBrand(page, payload.brand);
  if (payload.condition === null) {
    throw new Error('a listing without a condition passed validation');
  }
  await expectElement(
    page,
    LISTING_FORM.condition(payload.condition.id),
    FORM,
    `condition "${payload.condition.label}"`,
  );
  await page.click(LISTING_FORM.condition(payload.condition.id));
  if (payload.size !== null) await pickSize(page, payload.size);
  await chooseShipping(page);
  await fillPrice(page, payload.price.amountCents);
  await smartPricingOff(page);
}

/** Switches Mercari's Smart Pricing off when the form has it on. */
async function smartPricingOff(page: PageDriver): Promise<void> {
  if (!(await appears(page, LISTING_FORM.smartPricing, 2_000))) return;
  const shown = (await page.text(LISTING_FORM.smartPricing))?.trim().toUpperCase();
  if (shown !== 'ON') return;
  await page.click(LISTING_FORM.smartPricing);
  if (!(await appears(page, LISTING_FORM.smartPricingTurnOff))) {
    throw changed(FORM, 'asks nothing when Smart Pricing is switched off');
  }
  await page.click(LISTING_FORM.smartPricingTurnOff);
  const end = Date.now() + APPEAR_MS;
  while ((await page.text(LISTING_FORM.smartPricing))?.trim().toUpperCase() === 'ON') {
    if (Date.now() >= end) throw changed(FORM, 'kept Smart Pricing on');
    await new Promise((resolve) => setTimeout(resolve, LOOK_EVERY_MS));
  }
}

/** Fills only the price (a price change on the edit page). */
export async function fillPrice(page: PageDriver, cents: number): Promise<void> {
  await expectElement(page, LISTING_FORM.price, FORM, 'price field');
  await page.fill(LISTING_FORM.price, priceField(cents));
}

/** The category, a row per level in Mercari's category dialog; it closes on the last one. */
async function pickCategory(page: PageDriver, path: readonly string[]): Promise<void> {
  await expectElement(page, LISTING_FORM.category, FORM, 'category picker');
  await page.click(LISTING_FORM.category);
  for (const [level, name] of path.entries()) {
    const row = LISTING_FORM.categoryRow(name);
    if (!(await appears(page, row))) {
      throw changed(FORM, `offers no category level ${String(level + 1)} "${name}"`);
    }
    await page.click(row);
  }
  const chosen = (await page.text(LISTING_FORM.category))?.replace(/\s+/g, ' ').trim();
  if (chosen !== path.join(' > ')) throw changed(FORM, 'shows a different category than picked');
}

/** Searches Mercari's brand list and picks the exact brand; without one, the step stops. */
async function pickBrand(page: PageDriver, brand: string | null): Promise<void> {
  await expectElement(page, LISTING_FORM.brand, FORM, 'brand search');
  if (brand === null) return;
  await page.type(LISTING_FORM.brand, brand);
  const exact = `${LISTING_FORM.brandOption}:text-is("${quote(brand)}")`;
  if (await appears(page, exact)) {
    await page.click(exact);
    return;
  }
  const offered = await page.texts(LISTING_FORM.brandOption);
  const match = offered.find((option) => option.toLowerCase() === brand.toLowerCase());
  if (match === undefined) throw changed(FORM, `lists no brand "${brand}"`);
  await page.click(`${LISTING_FORM.brandOption}:text-is("${quote(match)}")`);
}

async function pickSize(page: PageDriver, size: string): Promise<void> {
  await expectElement(page, LISTING_FORM.size, FORM, 'size list');
  await page.click(LISTING_FORM.size);
  if (!(await appears(page, LISTING_FORM.sizeOption))) throw changed(FORM, 'shows no sizes');
  const offered = await page.texts(LISTING_FORM.sizeOption);
  const label = offered.find((option) => sizeOptionMatches(option, size));
  if (label === undefined) throw changed(FORM, `offers no size "${size}" for this category`);
  await page.click(`${LISTING_FORM.sizeOption}:text-is("${quote(label)}") >> nth=0`);
}

/**
 * Mercari's prepaid label, with the label Mercari recommends for the category, and no free
 * shipping (the buyer pays).
 */
async function chooseShipping(page: PageDriver): Promise<void> {
  await expectElement(page, LISTING_FORM.prepaidLabel, FORM, 'prepaid label shipping');
  await page.click(LISTING_FORM.prepaidLabel);
  if (!(await appears(page, LISTING_FORM.freeShipping))) {
    throw changed(FORM, 'asks nothing about free shipping for the prepaid label');
  }
  const label = await page.attribute(LISTING_FORM.shippingClass, 'value');
  if (label === null || label.trim() === '') throw changed(FORM, 'recommends no shipping label');
  await page.click(LISTING_FORM.freeShipping);
  if (!(await appears(page, LISTING_FORM.freeShippingNo))) {
    throw changed(FORM, 'offers no way to turn free shipping off');
  }
  await page.click(LISTING_FORM.freeShippingNo);
}

/** Whether `selector` is on the page within a moment (Mercari's scripts draw it). */
async function appears(page: PageDriver, selector: string, ms = APPEAR_MS): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await page.exists(selector)) return true;
    if (Date.now() >= end) return false;
    await new Promise((resolve) => setTimeout(resolve, LOOK_EVERY_MS));
  }
}

function quote(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export type Submitted =
  /** The form showed Mercari's validation message; nothing was listed or saved. */
  | { type: 'refused'; message: string }
  /** Mercari took it: it opened the listing's page (its id), or a page that doesn't name it. */
  | { type: 'listed'; itemId: string | null };

/** How long Mercari gets to answer a submit (its photos upload first). */
const ANSWER_MS = 45_000;

/**
 * Submits the form with its List (sell) or Save (edit) button, and waits for Mercari's answer:
 * the listing's page, or the form again with Mercari's message or a field marked as needing a
 * fix. Anything else leaves the outcome unknown, so the operation's check reads it back.
 */
export async function submitListing(page: PageDriver, button: 'list' | 'save'): Promise<Submitted> {
  const selector = LISTING_FORM[button];
  await expectElement(page, selector, FORM, `${button === 'list' ? 'List' : 'Save'} button`);
  const start = new URL(page.url()).pathname;
  await page.click(selector);
  const end = Date.now() + ANSWER_MS;
  for (;;) {
    const path = new URL(page.url()).pathname;
    const itemId = itemIdFromPath(path);
    if (itemId !== null) return { type: 'listed', itemId };
    if (await page.exists(LISTING_FORM.paymentWarning)) {
      return {
        type: 'refused',
        message:
          'Mercari asks for a credit or debit card on file before it lists. Add one in Mercari (Account settings > Payment methods), then list again.',
      };
    }
    const messages = (await page.texts(LISTING_FORM.error)).filter((text) => text !== '');
    if (messages.length > 0) return { type: 'refused', message: messages.join(' ') };
    if ((await page.count('[aria-invalid="true"]')) > 0) {
      return {
        type: 'refused',
        message: "Mercari didn't take the listing: it marked a field as needing a fix.",
      };
    }
    // Left the form for a page that doesn't name the listing (Mercari's own confirmation).
    if (path !== start && !path.startsWith(MERCARI_PATHS.sell))
      return { type: 'listed', itemId: null };
    if (Date.now() >= end) throw changed(FORM, 'showed no listing and no message after the submit');
    await new Promise((resolve) => setTimeout(resolve, LOOK_EVERY_MS));
    await page.waitFor('body', 'attached');
  }
}

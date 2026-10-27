/**
 * Mercari's listing form: the sell page (`/sell/`) for a new listing, and the same form on a
 * listing's edit page (`/sell/edit/<id>/`). Filling it changes nothing; only submitting it does.
 *
 * The form, in the order the script fills it: photos (one file input, in posting order), title,
 * description (with Listora's SKU line), the category level by level (each level's options
 * appear once the one above is picked), brand (typed into Mercari's brand search and picked from
 * its suggestions; the form takes only brands from its own list and requires one, so a brand it
 * doesn't list, or none, is its "No brand / Not sure"), condition, size (the payload's label,
 * from the category's size list), shipping (Mercari's prepaid label, paid by the buyer), and the
 * whole-dollar price. A category whose form asks for a phone's IMEI stops before anything is
 * sent: Listora doesn't have it.
 *
 * After submitting, the form either shows Mercari's validation message or its warning about a
 * prohibited item (a rejection in Mercari's own words, never passed with "Continue listing") or
 * opens the listing's page.
 */
import { withSkuLine } from '../../adapter/sku-line.ts';
import type { PageDriver, UploadFile } from '../../runner/types.ts';
import type { MercariListingPayload } from '../payload.ts';
import { itemIdFromPath, MERCARI_ITEM_ID, MERCARI_PATHS } from '../site.ts';
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
  anyCategoryRow: '[data-testid="DialogWrapper"] button[data-testid="CategoryRow"]',
  /** The first row with the name: Mercari lists one name twice under one category at most. */
  categoryRow: (name: string) =>
    `[data-testid="DialogWrapper"] button[data-testid="CategoryRow"]:text-is("${quote(name)}") >> nth=0`,
  brand: 'input[data-testid="Brand"]',
  brandOption: '[data-testid="Brand-option"]',
  /** The brands Mercari suggests once photos are in, as chips under the field (each a checkbox). */
  brandChipLabel: '[data-testid="SuggestedBrandChipGroup"] label',
  brandChipTicked: (name: string) =>
    `[data-testid="SuggestedBrandChipGroup"] input[type="checkbox"][aria-label="${quote(name)}"]:checked`,
  /** What to type for Mercari's "No brand / Not sure" option, and its label. */
  noBrandSearch: 'No brand',
  noBrand: 'No brand / Not sure',
  /** The field a category whose form wants a phone's IMEI shows. */
  imei: 'input[data-testid="IMEI"]',
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
  /** What its switch may ask to confirm turning it off with. */
  smartPricingTurnOff: 'button[data-testid="SmartPricingTurnOffButton"]',
  /** Mercari's answer to List from a seller without a card on file: add one first. */
  paymentWarning: '[data-testid="PaymentWarningModal"]',
  /**
   * Mercari's warning that a listing may break its rules ("Oops!", the reason, "Continue
   * listing", and a link to its Prohibited Items list), read from its sell page's code
   * 2026-10-27. Listora never continues past it: the step stops with Mercari's reason.
   */
  itemWarning: '[data-testid="ItemCreationWarningModalContinueButton"]',
  /** The parts around it, the innermost of which is the warning with its reason. */
  itemWarningBody: 'div:has([data-testid="ItemCreationWarningModalContinueButton"])',
  /**
   * Mercari's notice that the seller's selling is restricted until they confirm their contact
   * info, a dialog titled by this heading.
   */
  restrictedHeading: 'h2',
  restrictedTitle: 'Your ability to sell is restricted',
  /**
   * Mercari's page once a listing is up, after List and after an edit's Update alike (read
   * 2026-10-27: under the sell page's path, "Sell another item", "Share your listing").
   */
  listed: '[data-testid="SellAnotherItem"], [data-testid="ShareListing"]',
  /** Its link to the listing's page. */
  liveListing: 'a[data-testid="LiveListingLink"]',
  list: 'button[data-testid="ListButton"]',
  /** The edit page's submit: the same button, there named Update (read 2026-10-27). */
  save: 'button[data-testid="ListButton"]',
  error: '[data-testid="FormError"]',
} as const;

const FORM = 'listing form';
/** How long a picked category gets to open its subcategories, or close the dialog. */
const SUBCATEGORIES_MS = 3_000;
/** How long a part Mercari's scripts draw gets to appear, and how often it is looked at. */
const APPEAR_MS = 8_000;
const LOOK_EVERY_MS = 500;
/** How long the brand suggestions stay the same before Listora takes them as Mercari's answer. */
const BRAND_SETTLED_MS = 2_000;
/** How long an empty brand list gets to fill before the search counts as finding nothing. */
const BRAND_EMPTY_MS = 4_000;

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
 * `imei_required` when the category's form asks for a phone's IMEI, which Listora doesn't have:
 * nothing is sent.
 */
export async function fillListing(
  page: PageDriver,
  payload: MercariListingPayload,
  sku: string,
  photos: readonly UploadFile[] | null,
): Promise<'filled' | 'imei_required'> {
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
  if (payload.imei || (await appears(page, LISTING_FORM.imei, 1_000))) return 'imei_required';
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
  // Mercari draws the IMEI field once its own check of the category answers, which can come
  // after the rest of the form is filled (read 2026-10-27).
  if (await page.exists(LISTING_FORM.imei)) return 'imei_required';
  return 'filled';
}

/** Switches Mercari's Smart Pricing off when the form has it on. */
async function smartPricingOff(page: PageDriver): Promise<void> {
  if (!(await appears(page, LISTING_FORM.smartPricing, 2_000))) return;
  const shown = (await page.text(LISTING_FORM.smartPricing))?.trim().toUpperCase();
  if (shown !== 'ON') return;
  await page.click(LISTING_FORM.smartPricing);
  // Some sellers' forms ask to confirm (seen on the captain's phone); others switch it off at
  // once (seen on the Mac, 2026-10-27).
  const off = async (): Promise<boolean> =>
    (await page.text(LISTING_FORM.smartPricing))?.trim().toUpperCase() === 'OFF';
  if (!(await off()) && (await appears(page, LISTING_FORM.smartPricingTurnOff, 2_000))) {
    await page.click(LISTING_FORM.smartPricingTurnOff);
  }
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
  // A category with its own subcategories opens them: its "All <category>" row picks it whole
  // (the field then shows the category itself, read 2026-10-27). A leaf closes the dialog.
  const whole = LISTING_FORM.categoryRow(`All ${path.at(-1) ?? ''}`);
  const shown = async (): Promise<string | undefined> =>
    (await page.text(LISTING_FORM.category))?.replace(/\s+/g, ' ').trim();
  const end = Date.now() + SUBCATEGORIES_MS;
  while (Date.now() < end && (await shown()) !== path.join(' > ')) {
    if (await page.exists(whole)) {
      await page.click(whole);
      break;
    }
    if (!(await page.exists(LISTING_FORM.anyCategoryRow))) break;
    await new Promise((resolve) => setTimeout(resolve, LOOK_EVERY_MS));
  }
  const chosen = await shown();
  if (chosen !== path.join(' > ')) throw changed(FORM, 'shows a different category than picked');
}

/**
 * Picks the item's brand, or Mercari's "No brand / Not sure" when Mercari doesn't list it or the
 * item has none: Mercari needs one (the title and description still name the item's). Once
 * photos are in, Mercari suggests brands as chips under the field and may have filled one in
 * already (read 2026-10-27): a suggestion that is the brand is taken as it is. Otherwise the
 * field is searched, matching exactly, then ignoring case and punctuation (`Abercrombie and
 * Fitch` is Mercari's `Abercrombie & Fitch`), and again by the brand's first word.
 */
async function pickBrand(page: PageDriver, brand: string | null): Promise<void> {
  await expectElement(page, LISTING_FORM.brand, FORM, 'brand search');
  if (brand !== null) {
    if (await pickBrandChip(page, (name) => brandKey(name) === brandKey(brand))) return;
    const first = brand.split(/\s+/)[0] ?? '';
    const searches = [brand, ...(first.length >= 3 && first !== brand ? [first] : [])];
    for (const search of searches) {
      if (await pickBrandOption(page, search, brand)) return;
    }
  }
  if (await pickBrandChip(page, (name) => name === LISTING_FORM.noBrand)) return;
  if (!(await pickBrandOption(page, LISTING_FORM.noBrandSearch, LISTING_FORM.noBrand))) {
    throw changed(FORM, `offers no "${LISTING_FORM.noBrand}" brand`);
  }
}

/** Ticks the suggested brand chip whose name passes `wanted` (kept when already ticked). */
async function pickBrandChip(
  page: PageDriver,
  wanted: (name: string) => boolean,
): Promise<boolean> {
  const names = (await page.texts(LISTING_FORM.brandChipLabel)).map((name) => name.trim());
  const name = names.find(wanted);
  if (name === undefined) return false;
  if (!(await page.exists(LISTING_FORM.brandChipTicked(name)))) {
    await page.click(`${LISTING_FORM.brandChipLabel}:text-is("${quote(name)}") >> nth=0`);
  }
  return true;
}

/** Types `search` into the brand field and picks the option that is `wanted`, if it comes. */
async function pickBrandOption(page: PageDriver, search: string, wanted: string): Promise<boolean> {
  // Tapping the field starts a new search, clearing what it showed.
  await page.click(LISTING_FORM.brand);
  if (((await page.value(LISTING_FORM.brand)) ?? '') !== '') {
    await page.fill(LISTING_FORM.brand, '');
  }
  await page.type(LISTING_FORM.brand, search);
  // The suggestions follow Mercari's search as it answers each keystroke, so the list read first
  // may still be for the first letters: it is read until it offers the brand, or stays the same
  // for a moment without it.
  const end = Date.now() + APPEAR_MS;
  let previous: string | null = null;
  let settledAt = Date.now();
  for (;;) {
    const offered = await page.texts(LISTING_FORM.brandOption);
    const shown = offered.join('\n');
    if (shown !== previous) {
      previous = shown;
      settledAt = Date.now();
    }
    // An empty list may be Mercari still loading its brands: it gets longer to fill.
    const settled = offered.length === 0 ? BRAND_EMPTY_MS : BRAND_SETTLED_MS;
    const match =
      offered.find((option) => option === wanted) ??
      offered.find((option) => option.toLowerCase() === wanted.toLowerCase()) ??
      offered.find((option) => brandKey(option) === brandKey(wanted));
    if (match !== undefined) {
      await page.click(`${LISTING_FORM.brandOption}:text-is("${quote(match)}") >> nth=0`);
      return true;
    }
    if (Date.now() >= end || Date.now() - settledAt >= settled) return false;
    await new Promise((resolve) => setTimeout(resolve, LOOK_EVERY_MS));
  }
}

/** A brand name without case, punctuation, or spacing: `Levi's` and `LEVIS` are one. */
function brandKey(name: string): string {
  return name
    .toLowerCase()
    .replaceAll('&', 'and')
    .replace(/[^a-z0-9]+/g, '');
}

async function pickSize(page: PageDriver, size: string): Promise<void> {
  await expectElement(page, LISTING_FORM.size, FORM, 'size list');
  await page.click(LISTING_FORM.size);
  // A tap while Mercari is still redrawing the form after a photo's suggestions can miss: once
  // more before the list counts as missing.
  if (!(await appears(page, LISTING_FORM.sizeOption, 4_000))) {
    await page.click(LISTING_FORM.size);
    if (!(await appears(page, LISTING_FORM.sizeOption))) throw changed(FORM, 'shows no sizes');
  }
  const offered = await page.texts(LISTING_FORM.sizeOption);
  const spaced = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const label = offered.find((option) => spaced(option) === spaced(size));
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
/** The item Mercari's page after a submit links to as the live listing, when it does. */
async function linkedItem(page: PageDriver): Promise<string | null> {
  const href = await page.attribute(LISTING_FORM.liveListing, 'href');
  if (href === null) return null;
  try {
    return itemIdFromPath(new URL(href, page.url()).pathname);
  } catch {
    return null;
  }
}

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
    if (await page.exists(LISTING_FORM.itemWarning)) {
      const [body] = (await page.texts(LISTING_FORM.itemWarningBody)).sort(
        (a, b) => a.length - b.length,
      );
      const reason = body
        ?.replace(/Continue (listing|updating)|Learn more|Oops!/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return {
        type: 'refused',
        message: `Mercari warned that this listing may break its rules${reason === undefined || reason === '' ? '' : `: ${reason}`}. Listora didn't continue; check Mercari's Prohibited Items list and edit the listing.`,
      };
    }
    const headings = await page.texts(LISTING_FORM.restrictedHeading);
    if (headings.some((heading) => heading.trim() === LISTING_FORM.restrictedTitle)) {
      return {
        type: 'refused',
        message:
          'Mercari has restricted selling on this account until you confirm your contact info. Open Mercari and confirm it, then list again.',
      };
    }
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
    // Mercari's own page once the listing is up, which names the item in its path or its link
    // to the listing.
    if (await page.exists(LISTING_FORM.listed)) {
      const named = path.split('/').find((segment) => MERCARI_ITEM_ID.test(segment));
      return { type: 'listed', itemId: named ?? (await linkedItem(page)) };
    }
    // Left the form for a page that doesn't name the listing.
    if (path !== start && !path.startsWith(MERCARI_PATHS.sell)) {
      return { type: 'listed', itemId: null };
    }
    if (Date.now() >= end) throw changed(FORM, 'showed no listing and no message after the submit');
    await new Promise((resolve) => setTimeout(resolve, LOOK_EVERY_MS));
    await page.waitFor('body', 'attached');
  }
}

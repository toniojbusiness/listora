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
import { weightLabel } from '../shipping.ts';
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
import { ITEM_PAGE } from './item-page.ts';

export const LISTING_FORM = {
  form: 'form[data-testid="ListingForm"]',
  photos: 'input[type="file"][data-testid="PhotoInput"]',
  title: '[data-testid="Title"]',
  description: '[data-testid="Description"]',
  category: (level: number) => `select[data-testid="CategoryL${String(level)}"]`,
  brand: 'input[data-testid="Brand"]',
  brandSuggestions: '[data-testid="BrandSuggestions"]',
  brandSuggestion: '[data-testid="BrandSuggestion"]',
  condition: (id: number) => `input[name="condition"][value="${String(id)}"]`,
  size: 'select[data-testid="Size"]',
  shippingPayer: 'select[data-testid="ShippingPayer"]',
  shippingWeight: 'select[data-testid="ShippingWeight"]',
  price: 'input[data-testid="Price"]',
  list: 'button[data-testid="ListButton"]',
  save: 'button[data-testid="SaveButton"]',
  error: '[data-testid="FormError"]',
} as const;

const FORM = 'listing form';

/** Opens the sell page's empty form. */
export async function openSellForm(page: PageDriver, site: MercariSite): Promise<void> {
  await page.goto(absolute(site, MERCARI_PATHS.sell));
  // Drawn by the site's own scripts once the document is ready.
  await awaitElement(page, LISTING_FORM.form, 'sell page', FORM);
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
  if (photos !== null) await page.upload(LISTING_FORM.photos, photos);
  await page.fill(LISTING_FORM.title, payload.title);
  await page.fill(LISTING_FORM.description, withSkuLine(payload.description, sku));
  if (payload.category === null) throw new Error('a listing without a category passed validation');
  for (const [level, name] of payload.category.entries()) {
    await pickOption(
      page,
      LISTING_FORM.category(level),
      name,
      `category level ${String(level + 1)}`,
    );
  }
  await pickBrand(page, payload.brand);
  if (payload.condition === null)
    throw new Error('a listing without a condition passed validation');
  await expectElement(
    page,
    LISTING_FORM.condition(payload.condition.id),
    FORM,
    `condition "${payload.condition.label}"`,
  );
  await page.check(LISTING_FORM.condition(payload.condition.id), true);
  if (payload.size !== null) await pickSize(page, payload.size);
  await pickOption(page, LISTING_FORM.shippingPayer, 'Buyer', 'shipping payer');
  await pickOption(
    page,
    LISTING_FORM.shippingWeight,
    weightLabel(payload.shipping.weight),
    'package weight',
  );
  await page.fill(LISTING_FORM.price, priceField(payload.price.amountCents));
}

/** Fills only the price (a price change on the edit page). */
export async function fillPrice(page: PageDriver, cents: number): Promise<void> {
  await expectElement(page, LISTING_FORM.price, FORM, 'price field');
  await page.fill(LISTING_FORM.price, priceField(cents));
}

export type Submitted =
  /** The form showed Mercari's validation message; nothing was listed or saved. */
  | { type: 'refused'; message: string }
  /** Mercari opened the listing's page. */
  | { type: 'listed'; itemId: string };

/** Submits the form with its List (sell) or Save (edit) button. */
export async function submitListing(page: PageDriver, button: 'list' | 'save'): Promise<Submitted> {
  const selector = LISTING_FORM[button];
  await expectElement(page, selector, FORM, `${button === 'list' ? 'List' : 'Save'} button`);
  await page.click(selector);
  // Whichever comes: the form again with Mercari's message, or the listing's page.
  await page.waitFor(`${LISTING_FORM.error}, ${ITEM_PAGE.root}`);
  const message = await page.text(LISTING_FORM.error);
  if (message !== null) return { type: 'refused', message };
  const itemId = itemIdFromPath(new URL(page.url()).pathname);
  if (itemId === null) throw changed(FORM, 'opened a page that is not a listing');
  return { type: 'listed', itemId };
}

/** Picks the option labeled `label` (the options may appear only after an earlier pick). */
async function pickOption(
  page: PageDriver,
  select: string,
  label: string,
  what: string,
): Promise<void> {
  await expectElement(page, select, FORM, what);
  await page.waitFor(`${select} option:not([value=""])`, 'attached');
  const offered = await page.texts(`${select} option`);
  if (!offered.includes(label)) throw changed(FORM, `offers no ${what} "${label}"`);
  await page.select(select, label);
}

async function pickSize(page: PageDriver, size: string): Promise<void> {
  await expectElement(page, LISTING_FORM.size, FORM, 'size list');
  await page.waitFor(`${LISTING_FORM.size} option:not([value=""])`, 'attached');
  const offered = await page.texts(`${LISTING_FORM.size} option`);
  const label = offered.find((option) => sizeOptionMatches(option, size));
  if (label === undefined) throw changed(FORM, `offers no size "${size}" for this category`);
  await page.select(LISTING_FORM.size, label);
}

/** Searches Mercari's brand list and picks the exact brand, or leaves the brand empty. */
async function pickBrand(page: PageDriver, brand: string | null): Promise<void> {
  await expectElement(page, LISTING_FORM.brand, FORM, 'brand search');
  await page.fill(LISTING_FORM.brand, '');
  if (brand === null) return;
  await page.type(LISTING_FORM.brand, brand);
  await page.waitFor(LISTING_FORM.brandSuggestions);
  const suggestions = await page.texts(LISTING_FORM.brandSuggestion);
  const index = suggestions.findIndex(
    (suggestion) => suggestion.toLowerCase() === brand.toLowerCase(),
  );
  if (index === -1) {
    await page.fill(LISTING_FORM.brand, '');
    return;
  }
  await page.click(`${LISTING_FORM.brandSuggestion} >> nth=${String(index)}`);
}

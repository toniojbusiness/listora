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
 * words) or opens the product's page.
 */
import type { PageDriver, UploadFile } from '../../runner/types.ts';
import { depopListingText, depopPriceField, type DepopAutomationPayload } from '../payload.ts';
import { DEPOP_PATHS, slugFromPath } from '../site.ts';
import { sizeOptionMatches } from '../sizes.ts';
import { absolute, awaitElement, changed, expectElement, type DepopSite } from './common.ts';
import { PRODUCT_PAGE } from './product-page.ts';

export const LISTING_FORM = {
  form: 'form[data-testid="listingForm"]',
  photos: 'input[type="file"][data-testid="listingForm__photos"]',
  description: 'textarea[data-testid="listingForm__description"]',
  category: (level: number) => `select[data-testid="listingForm__category${String(level)}"]`,
  size: 'select[data-testid="listingForm__size"]',
  brand: 'input[data-testid="listingForm__brand"]',
  brandSuggestions: '[data-testid="listingForm__brandSuggestions"]',
  brandSuggestion: '[data-testid="listingForm__brandSuggestion"]',
  condition: (value: string) => `input[name="condition"][value="${value}"]`,
  price: 'input[data-testid="listingForm__price"]',
  post: 'button[data-testid="listingForm__post"]',
  save: 'button[data-testid="listingForm__save"]',
  error: '[data-testid="listingForm__error"]',
} as const;

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
  await expectElement(page, LISTING_FORM.form, FORM, FORM);
  if (photos !== null) {
    await expectElement(page, LISTING_FORM.photos, FORM, 'photo input');
    await page.upload(LISTING_FORM.photos, photos);
  }
  await expectElement(page, LISTING_FORM.description, FORM, 'description field');
  await page.fill(LISTING_FORM.description, depopListingText(payload, sku));
  if (payload.category === null) throw new Error('a listing without a category passed validation');
  for (const [level, name] of payload.category.entries()) {
    await pickOption(
      page,
      LISTING_FORM.category(level),
      name,
      `category level ${String(level + 1)}`,
    );
  }
  if (payload.size !== null) await pickSize(page, payload.size);
  await pickBrand(page, payload.brand);
  if (payload.condition === null) {
    throw new Error('a listing without a condition passed validation');
  }
  const condition = LISTING_FORM.condition(payload.condition.value);
  await expectElement(page, condition, FORM, `condition "${payload.condition.label}"`);
  await page.check(condition, true);
  await fillPrice(page, payload.price.amountCents);
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

/** Submits the form with its Post (sell) or Save (edit) button. */
export async function submitListing(page: PageDriver, button: 'post' | 'save'): Promise<Submitted> {
  const selector = LISTING_FORM[button];
  await expectElement(page, selector, FORM, `${button === 'post' ? 'Post' : 'Save'} button`);
  await page.click(selector);
  // Whichever comes: the form again with Depop's message, or the product's page.
  await page.waitFor(`${LISTING_FORM.error}, ${PRODUCT_PAGE.root}`);
  const message = await page.text(LISTING_FORM.error);
  if (message !== null) return { type: 'refused', message };
  const slug = slugFromPath(new URL(page.url()).pathname);
  if (slug === null) throw changed(FORM, 'opened a page that is not a product');
  return { type: 'posted', slug };
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

/** Searches Depop's brand list and picks the exact brand, or leaves the brand empty. */
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

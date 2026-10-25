/**
 * eBay's listing form (`/lstng`): a new listing (`mode=AddItem`, opened in its category), a
 * change to one (`mode=ReviseItem`), and a relist of an ended one (`mode=RelistItem`, filled
 * with the old listing, which eBay lists under a new item number). Filling it changes nothing;
 * only submitting it does. eBay opens the form in the category the address names
 * (`categoryId`), which the form shows; the script checks it is the payload's.
 *
 * The form, in the order the script fills it: photos (one file input, in posting order, the
 * first the cover), the title, the Custom label (Listora's SKU, as the API adapter sends it),
 * the item specifics (a field for each the category asks for, by name; any other is added as a
 * custom item specific; several values are separated by commas), the condition (its options'
 * values are eBay's condition ids), the condition description, the description (the editor's
 * HTML view, with the HTML the API adapter sends), and the Buy It Now price in dollars and
 * cents. Shipping, payment, and returns are left as the seller set them up: the form starts
 * with the seller's own policies, and a seller with none gets eBay's own message asking for
 * them (a rejection the user can fix).
 *
 * After submitting, the form either shows eBay's message (a rejection in eBay's own words) or
 * opens the listing's page.
 */
import type { EbayItemSpecific } from '@listora/marketplaces';

import type { PageDriver, UploadFile } from '../../runner/types.ts';
import { ebayPriceField, type EbayAutomationPayload } from '../payload.ts';
import { EBAY_PATHS, itemIdFromPath, type EbayFormMode } from '../site.ts';
import { absolute, changed, expectElement, type EbaySite } from './common.ts';
import { ITEM_PAGE } from './item-page.ts';

export const LISTING_FORM = {
  form: 'form[data-testid="listing-form"]',
  category: '[data-testid="listing-form__category"]',
  photos: 'input[type="file"][name="photos"]',
  title: 'input[name="title"]',
  customLabel: 'input[name="customLabel"]',
  itemSpecific: '[data-testid="item-specific"]',
  itemSpecificInput: (name: string) =>
    `[data-testid="item-specific"][data-name="${name.replaceAll('"', '\\"')}"] input`,
  addItemSpecific: 'button[data-testid="add-item-specific"]',
  customItemSpecific: '[data-testid="custom-item-specific"]',
  condition: 'select[name="condition"]',
  conditionDescription: 'textarea[name="conditionDescription"]',
  description: 'textarea[name="description"]',
  price: 'input[name="price"]',
  submit: 'button[data-testid="listing-form__submit"]',
  error: '[data-testid="listing-form__error"]',
} as const;

const FORM = 'listing form';

/** Opens the form for a new listing in its category. */
export async function openNewListingForm(
  page: PageDriver,
  site: EbaySite,
  categoryId: string,
): Promise<void> {
  await page.goto(absolute(site, EBAY_PATHS.form('AddItem', { categoryId })));
  await expectElement(page, LISTING_FORM.form, 'listing form for a new listing', FORM);
}

export type FormOpened = 'editing' | 'not_editable';

/**
 * Opens the form for an existing listing, in `categoryId` when given; `not_editable` when eBay
 * showed something else (the listing's page, for a listing it can't revise or relist).
 */
export async function openListingForm(
  page: PageDriver,
  site: EbaySite,
  mode: Exclude<EbayFormMode, 'AddItem'>,
  itemId: string,
  categoryId: string | null,
): Promise<FormOpened> {
  await page.goto(absolute(site, EBAY_PATHS.form(mode, { itemId, categoryId })));
  return (await page.exists(LISTING_FORM.form)) ? 'editing' : 'not_editable';
}

/**
 * Fills the whole form from the payload, with the SKU as the Custom label. `photos` are
 * uploaded in the order given; `null` leaves the listing's photos as they are (a revise or a
 * relist).
 */
export async function fillListing(
  page: PageDriver,
  payload: EbayAutomationPayload,
  sku: string,
  photos: readonly UploadFile[] | null,
): Promise<void> {
  await expectElement(page, LISTING_FORM.form, FORM, FORM);
  if (payload.categoryId === null) {
    throw new Error('a listing without a category passed validation');
  }
  const category = await page.attribute(LISTING_FORM.category, 'data-category-id');
  if (category !== payload.categoryId) {
    throw changed(FORM, `is not in category ${payload.categoryId}`);
  }
  if (photos !== null) {
    await expectElement(page, LISTING_FORM.photos, FORM, 'photo input');
    await page.upload(LISTING_FORM.photos, photos);
  }
  await expectElement(page, LISTING_FORM.title, FORM, 'title field');
  await page.fill(LISTING_FORM.title, payload.title);
  await expectElement(page, LISTING_FORM.customLabel, FORM, 'Custom label (SKU) field');
  await page.fill(LISTING_FORM.customLabel, sku);
  await fillItemSpecifics(page, payload.itemSpecifics);
  if (payload.condition === null)
    throw new Error('a listing without a condition passed validation');
  await expectElement(page, LISTING_FORM.condition, FORM, 'condition list');
  const offered = await page.attributes(`${LISTING_FORM.condition} option`, 'value');
  if (!offered.includes(String(payload.condition.id))) {
    throw changed(FORM, `offers no condition "${payload.condition.label}" for this category`);
  }
  await page.select(LISTING_FORM.condition, String(payload.condition.id));
  if (await page.exists(LISTING_FORM.conditionDescription)) {
    await page.fill(LISTING_FORM.conditionDescription, payload.conditionDescription ?? '');
  }
  await expectElement(page, LISTING_FORM.description, FORM, 'description editor');
  await page.fill(LISTING_FORM.description, payload.descriptionHtml);
  await fillPrice(page, payload.price.amountCents);
}

/** Fills only the price (a price change on the revise form). */
export async function fillPrice(page: PageDriver, cents: number): Promise<void> {
  await expectElement(page, LISTING_FORM.price, FORM, 'price field');
  await page.fill(LISTING_FORM.price, ebayPriceField(cents));
}

export type Submitted =
  /** The form showed eBay's message; nothing was listed or saved. */
  | { type: 'refused'; message: string }
  /** eBay opened the listing's page. */
  | { type: 'listed'; itemId: string };

/** Submits the form ("List it" for a new listing or a relist, "Revise it" for a change). */
export async function submitListing(page: PageDriver): Promise<Submitted> {
  await expectElement(page, LISTING_FORM.submit, FORM, 'submit button');
  await page.click(LISTING_FORM.submit);
  // Whichever comes: the form again with eBay's message, or the listing's page.
  await page.waitFor(`${LISTING_FORM.error}, ${ITEM_PAGE.root}`);
  const message = await page.text(LISTING_FORM.error);
  if (message !== null) return { type: 'refused', message };
  const itemId = itemIdFromPath(new URL(page.url()).pathname);
  if (itemId === null) throw changed(FORM, 'opened a page that is not a listing');
  return { type: 'listed', itemId };
}

/** What the revise form of a listing on sale holds that its page does not show. */
export interface FormListing {
  /** The description, as the editor's HTML view holds it. */
  descriptionHtml: string;
  /** The Custom label: the SKU Listora typed, or the seller's own. */
  sku: string | null;
}

/**
 * Opens a listing's revise form only to read it (nothing is typed, nothing submitted); `null`
 * when eBay shows no form for it (a listing that sold or ended).
 */
export async function readListingForm(
  page: PageDriver,
  site: EbaySite,
  itemId: string,
): Promise<FormListing | null> {
  if ((await openListingForm(page, site, 'ReviseItem', itemId, null)) === 'not_editable') {
    return null;
  }
  await expectElement(page, LISTING_FORM.description, FORM, 'description editor');
  const sku = (await page.attribute(LISTING_FORM.customLabel, 'value'))?.trim() ?? '';
  return {
    descriptionHtml: (await page.text(LISTING_FORM.description)) ?? '',
    sku: sku === '' ? null : sku,
  };
}

/**
 * Fills each item specific into the category's field of that name (ignoring case), or adds it
 * as a custom item specific when the form has no such field.
 */
async function fillItemSpecifics(
  page: PageDriver,
  specifics: readonly EbayItemSpecific[],
): Promise<void> {
  const fields = (await page.attributes(LISTING_FORM.itemSpecific, 'data-name')).filter(
    (name): name is string => name !== null,
  );
  if (fields.length === 0)
    throw changed(FORM, `has no item specifics (${LISTING_FORM.itemSpecific})`);
  for (const specific of specifics) {
    const value = specific.values.join(', ');
    const field = fields.find((name) => name.toLowerCase() === specific.name.toLowerCase());
    if (field !== undefined) {
      await page.fill(LISTING_FORM.itemSpecificInput(field), value);
      continue;
    }
    await expectElement(page, LISTING_FORM.addItemSpecific, FORM, '"Add item specific" button');
    const index = await page.count(LISTING_FORM.customItemSpecific);
    await page.click(LISTING_FORM.addItemSpecific);
    const row = `${LISTING_FORM.customItemSpecific} >> nth=${String(index)}`;
    await page.waitFor(row, 'attached');
    await page.fill(`${row} >> input[data-field="name"]`, specific.name);
    await page.fill(`${row} >> input[data-field="value"]`, value);
  }
}

/**
 * Ending a listing early (`/sh/lst/end?itemId=<item number>`): Seller Hub asks why, and ends
 * the listing once the seller confirms, then opens the listing's page, now showing it ended.
 * Listora gives eBay's reason "The item is no longer available", the one a sale elsewhere is.
 * eBay keeps an ended listing, which a relist puts back on sale under a new item number.
 */
import type { PageDriver } from '../../runner/types.ts';
import { EBAY_PATHS } from '../site.ts';
import { absolute, expectElement, type EbaySite } from './common.ts';
import { ITEM_PAGE } from './item-page.ts';

export const END_PAGE = {
  form: 'form[data-testid="end-listing"]',
  reason: 'input[name="reason"][value="NotAvailable"]',
  submit: 'button[data-testid="end-listing__submit"]',
} as const;

const PAGE = 'end listing page';

/** Opens the end page of a listing on sale. */
export async function openEndPage(page: PageDriver, site: EbaySite, itemId: string): Promise<void> {
  await page.goto(absolute(site, EBAY_PATHS.end(itemId)));
  await expectElement(page, END_PAGE.form, PAGE, 'end listing form');
  await expectElement(page, END_PAGE.reason, PAGE, 'reason "The item is no longer available"');
  await page.check(END_PAGE.reason, true);
}

/** Ends the listing the end page shows, and waits for its page. */
export async function endListing(page: PageDriver): Promise<void> {
  await expectElement(page, END_PAGE.submit, PAGE, 'End listing button');
  await page.click(END_PAGE.submit);
  await page.waitFor(ITEM_PAGE.root);
}

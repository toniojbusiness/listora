/**
 * A listing's edit page (`/products/edit/<slug>/`): the listing form filled with the listing,
 * plus Delete, which asks to confirm in the browser's own dialog and then opens the product's
 * page, now showing it deleted. Depop has no way to take a listing off sale and keep it for
 * sale later, so Listora ends a Depop listing by deleting it, and a relist is a new listing
 * (as with Depop's API, where a relist is a new product). Depop shows no edit page for a sold or
 * deleted listing: it shows the product's page instead.
 */
import type { PageDriver } from '../../runner/types.ts';
import { DEPOP_PATHS } from '../site.ts';
import { absolute, expectElement, type DepopSite } from './common.ts';
import { LISTING_FORM } from './listing-form.ts';

export const EDIT_PAGE = {
  delete: 'button[data-testid="listingForm__delete"]',
} as const;

export type EditorOpened = 'editing' | 'not_editable';

/** Opens the editor; `not_editable` when Depop showed something else (a sold listing). */
export async function openEditor(
  page: PageDriver,
  site: DepopSite,
  slug: string,
): Promise<EditorOpened> {
  await page.goto(absolute(site, DEPOP_PATHS.edit(slug)));
  return (await page.exists(LISTING_FORM.form)) ? 'editing' : 'not_editable';
}

/** Deletes the listing the editor shows, confirming Depop's prompt, and waits for its page. */
export async function deleteListing(page: PageDriver): Promise<void> {
  await expectElement(page, EDIT_PAGE.delete, 'edit page', 'Delete button');
  page.acceptNextDialog();
  await page.click(EDIT_PAGE.delete);
  // Depop opens the product's page; the operation's check reads it.
  await page.waitForPath(/^\/products\/[^/]+\/?$/);
}

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
import { absolute, awaitElement, changed, lookAgain, type DepopSite } from './common.ts';
import { LISTING_FORM } from './listing-form.ts';

/**
 * Read on the captain's session (2026-10-26): the seller's own product page has "Delete listing",
 * which opens a dialog ("Are you sure you want to delete this listing? You will lose all the
 * likes.") with Cancel and its own "Delete listing".
 */
export const EDIT_PAGE = {
  delete: 'button:text-is("Delete listing")',
  dialog: 'aside[role="dialog"]',
  confirm: 'aside[role="dialog"] button:text-is("Delete listing")',
} as const;

/** How long Depop gets to show its dialog and to close it once the listing is deleted. */
const DIALOG_MS = 20_000;

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

/** Checks the product page has its Delete listing button, before the step that deletes. */
export async function expectDelete(page: PageDriver): Promise<void> {
  // Drawn by the page's scripts for its seller, a moment after the page loads.
  await awaitElement(page, EDIT_PAGE.delete, 'product page', 'Delete listing button');
}

/**
 * Deletes the listing the product page shows: Delete listing, then the dialog's own Delete
 * listing. The operation's check reads the product afterwards.
 */
export async function deleteListing(page: PageDriver): Promise<void> {
  await page.click(EDIT_PAGE.delete);
  if (!(await within(page, () => page.exists(EDIT_PAGE.confirm)))) {
    throw changed('product page', 'shows no Delete listing dialog');
  }
  await page.click(EDIT_PAGE.confirm);
  if (!(await within(page, async () => !(await page.exists(EDIT_PAGE.dialog))))) {
    throw changed('product page', 'kept its Delete listing dialog open');
  }
}

async function within(page: PageDriver, done: () => Promise<boolean>): Promise<boolean> {
  const end = Date.now() + DIALOG_MS;
  for (;;) {
    if (await done()) return true;
    if (Date.now() >= end) return false;
    await lookAgain(page, 500);
  }
}

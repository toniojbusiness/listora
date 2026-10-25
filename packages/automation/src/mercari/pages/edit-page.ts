/**
 * A listing's edit page (`/sell/edit/<id>/`): the listing form filled with the listing, plus
 * Deactivate (an active listing) or Activate (an inactive one). Each asks to confirm in a
 * dialog of the page and then opens the listing's page. Listora ends a Mercari listing by
 * deactivating it, which keeps it, so a relist activates the same listing (and the same id);
 * it never deletes one. Mercari has no edit page for a sold listing: it shows the listing's
 * page instead.
 */
import type { PageDriver } from '../../runner/types.ts';
import { MERCARI_PATHS } from '../site.ts';
import { absolute, expectElement, type MercariSite } from './common.ts';
import { ITEM_PAGE } from './item-page.ts';
import { LISTING_FORM } from './listing-form.ts';

export const EDIT_PAGE = {
  deactivate: 'button[data-testid="DeactivateButton"]',
  activate: 'button[data-testid="ActivateButton"]',
  confirmDialog: '[role="dialog"][data-testid="ConfirmModal"]',
  confirm: '[role="dialog"][data-testid="ConfirmModal"] button[data-testid="ConfirmButton"]',
} as const;

const PAGE = 'edit page';

export type EditorOpened = 'editing' | 'not_editable';

/** Opens the editor; `not_editable` when Mercari showed something else (a sold listing). */
export async function openEditor(
  page: PageDriver,
  site: MercariSite,
  id: string,
): Promise<EditorOpened> {
  await page.goto(absolute(site, MERCARI_PATHS.edit(id)));
  return (await page.exists(LISTING_FORM.form)) ? 'editing' : 'not_editable';
}

/** Deactivates the listing the editor shows, and waits for its page. */
export async function deactivate(page: PageDriver): Promise<void> {
  await confirmed(page, EDIT_PAGE.deactivate, 'Deactivate button');
}

/** Activates the inactive listing the editor shows, and waits for its page. */
export async function activate(page: PageDriver): Promise<void> {
  await confirmed(page, EDIT_PAGE.activate, 'Activate button');
}

async function confirmed(page: PageDriver, button: string, what: string): Promise<void> {
  await expectElement(page, button, PAGE, what);
  await page.click(button);
  await page.waitFor(EDIT_PAGE.confirmDialog);
  await page.click(EDIT_PAGE.confirm);
  await page.waitFor(ITEM_PAGE.root);
}

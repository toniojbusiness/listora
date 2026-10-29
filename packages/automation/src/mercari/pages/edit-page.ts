/**
 * A listing's edit page (`/sell/edit/<id>/`): the listing form filled with the listing, then
 * Deactivate (an active listing) or Activate (an inactive one), Delete, and Update (the form's
 * submit). Read on the seller's own listing, 2026-10-27: the form is drawn seconds after the
 * document loads (11 seconds there), and Deactivate acts at once, with no confirmation, and opens
 * the seller's active listings. Listora ends a Mercari listing by deactivating it, which keeps
 * it, so a relist activates the same listing (and the same id); it never deletes one. Mercari
 * has no edit page for a sold listing: it shows the listing's page instead.
 */
import type { PageDriver } from '../../runner/types.ts';
import { MERCARI_PATHS } from '../site.ts';
import { absolute, changed, lookAgain, type MercariSite } from './common.ts';
import { LISTING_FORM } from './listing-form.ts';

export const EDIT_PAGE = {
  /** Deactivate on an active listing, Activate on an inactive one. */
  toggle: 'button[data-testid="ActivateDeactivateButton"]',
} as const;

const PAGE = 'edit page';

/** How long the edit page may take to draw its form, or to answer the toggle. */
const DRAW_MS = 25_000;
// A look only reads the page (no action, so no pacing): a short interval loses less time
// after the element appears.
const LOOK_EVERY_MS = 150;

export type EditorOpened = 'editing' | 'not_editable';

/**
 * Opens the editor; `not_editable` when Mercari showed something else (a sold listing's page) or
 * answered with an error (a listing it removed).
 */
export async function openEditor(
  page: PageDriver,
  site: MercariSite,
  id: string,
): Promise<EditorOpened> {
  await page.goto(absolute(site, MERCARI_PATHS.edit(id)));
  // No edit page for this listing (one Mercari removed): there is no form to wait for.
  const status = page.status();
  if (status !== null && status >= 400) return 'not_editable';
  const end = Date.now() + DRAW_MS;
  for (;;) {
    if (await page.exists(LISTING_FORM.form)) return 'editing';
    if (!onEditPage(page) || Date.now() >= end) return 'not_editable';
    await lookAgain(page, LOOK_EVERY_MS);
  }
}

/**
 * Whether the listing the editor shows is active (its toggle says Deactivate) or inactive (it
 * says Activate): an end or relist reads this on the edit page it acts on, with no read of the
 * listing's own page first. A toggle that says something else is a page Listora doesn't know.
 */
export async function editorShows(page: PageDriver): Promise<'active' | 'inactive'> {
  const shown = (await page.text(EDIT_PAGE.toggle))?.trim();
  if (shown === 'Deactivate') return 'active';
  if (shown === 'Activate') return 'inactive';
  throw changed(PAGE, `has no Activate or Deactivate button (${EDIT_PAGE.toggle})`);
}

/** Deactivates the listing the editor shows, and waits for Mercari to take it. */
export async function deactivate(page: PageDriver): Promise<void> {
  await toggled(page, 'Deactivate');
}

/** Activates the inactive listing the editor shows, and waits for Mercari to take it. */
export async function activate(page: PageDriver): Promise<void> {
  await toggled(page, 'Activate');
}

/**
 * Clicks the toggle when it says `label`, and waits for the page Mercari opens once it took the
 * change (it leaves the edit page). A toggle that says something else is a page Listora doesn't
 * know: nothing is clicked.
 */
async function toggled(page: PageDriver, label: 'Activate' | 'Deactivate'): Promise<void> {
  const shown = (await page.text(EDIT_PAGE.toggle))?.trim();
  if (shown !== label) throw changed(PAGE, `has no ${label} button (${EDIT_PAGE.toggle})`);
  await page.click(EDIT_PAGE.toggle);
  const end = Date.now() + DRAW_MS;
  while (onEditPage(page)) {
    if (Date.now() >= end) throw changed(PAGE, `stayed open after ${label}`);
    await lookAgain(page, LOOK_EVERY_MS);
  }
}

/** Whether the page is still an edit page (`/sell/edit/<id>/`). */
function onEditPage(page: PageDriver): boolean {
  return new URL(page.url()).pathname.startsWith('/sell/edit/');
}

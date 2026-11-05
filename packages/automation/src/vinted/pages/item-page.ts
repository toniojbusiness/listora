/**
 * A listing's own page (`/items/<id>`) as its seller sees it: the controls Vinted shows only to
 * the seller, of which Listora uses Hide and Unhide (docs/features/vinted.md, "Create, price,
 * hide, and unhide").
 *
 * - **Hide** takes the listing off sale and keeps it, with its likes and its id, and **Unhide**
 *   puts it back: Listora's end and relist. Vinted's terms ban deleting and relisting the same
 *   item, so Listora never deletes a listing to end it, and a relist is always an unhide.
 * - While Vinted reviews a listing it shows neither, and refuses to hide or delete it: the end
 *   then waits for the review (the scripts read the review from the web API before they act).
 *
 * Modeled until the mapping (Vinted plan M2) reads a seller's own item page: Hide and Unhide are
 * buttons that act at once, and the page then shows the other one. A page without the one the
 * script expects stops the step before anything is sent (`PageChangedError`).
 */
import type { PageDriver } from '../../runner/types.ts';
import { itemPath } from '../site.ts';
import { absolute, appears, changed, type VintedSite } from './common.ts';

export const ITEM_PAGE = {
  hide: 'button[data-testid="item-hide-button"]',
  unhide: 'button[data-testid="item-unhide-button"]',
} as const;

const PAGE = 'listing page';
/** How long the page gets to draw the seller's controls, and to answer a tap on one. */
const APPEAR_MS = 8_000;

/** Opens the listing's page as its seller; `false` when Vinted answers that it has none (404). */
export async function openItemPage(
  page: PageDriver,
  site: VintedSite,
  id: string,
): Promise<boolean> {
  await page.goto(absolute(site, itemPath(id)));
  return page.status() !== 404;
}

/**
 * Whether the open page offers the seller `control` (Hide or Unhide) within its time. A listing
 * already hidden offers Unhide, and one on sale Hide.
 */
export function offers(page: PageDriver, control: 'hide' | 'unhide'): Promise<boolean> {
  return appears(page, ITEM_PAGE[control], APPEAR_MS);
}

/**
 * Taps Hide (or Unhide) on the open page, then waits for the page to offer the other: the one
 * step that changes the listing. A page that never does is one Listora no longer understands;
 * the change may have been sent, so the read-back decides.
 */
export async function toggleHidden(page: PageDriver, control: 'hide' | 'unhide'): Promise<void> {
  if (!(await page.exists(ITEM_PAGE[control]))) {
    throw changed(PAGE, `has no ${control === 'hide' ? 'Hide' : 'Unhide'} for this listing`);
  }
  await page.click(ITEM_PAGE[control]);
  const after = control === 'hide' ? 'unhide' : 'hide';
  if (!(await appears(page, ITEM_PAGE[after], APPEAR_MS))) {
    throw changed(PAGE, `didn't show the listing ${control === 'hide' ? 'hidden' : 'for sale'}`);
  }
}

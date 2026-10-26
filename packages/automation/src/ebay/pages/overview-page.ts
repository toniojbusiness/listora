/**
 * Seller Hub's overview (`/sh/ovw`), which only a logged-in seller sees: the health check opens
 * it to show the session works. A session eBay rejected lands on its sign-in page instead, which
 * the runner's safety rules stop at.
 */
import type { PageDriver } from '../../runner/types.ts';
import { EBAY_PATHS } from '../site.ts';
import { absolute, expectElement, type EbaySite } from './common.ts';

export const OVERVIEW_PAGE = {
  root: '[data-testid="seller-hub-overview"]',
} as const;

export async function openOverview(page: PageDriver, site: EbaySite): Promise<void> {
  await page.goto(absolute(site, EBAY_PATHS.overview));
  await expectElement(page, OVERVIEW_PAGE.root, 'Seller Hub overview', 'Seller Hub overview');
}

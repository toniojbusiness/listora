/**
 * The selling hub's home (`/sellinghub/`), which only a logged-in seller sees: the health check
 * opens it to show the session works. A session Depop rejected lands on its login page instead,
 * which the runner's safety rules stop at.
 */
import type { PageDriver } from '../../runner/types.ts';
import { DEPOP_PATHS } from '../site.ts';
import { absolute, expectElement, type DepopSite } from './common.ts';

export const HUB_PAGE = {
  root: '[data-testid="sellingHub"]',
} as const;

export async function openHub(page: PageDriver, site: DepopSite): Promise<void> {
  await page.goto(absolute(site, DEPOP_PATHS.hub));
  await expectElement(page, HUB_PAGE.root, 'selling hub', 'selling hub');
}

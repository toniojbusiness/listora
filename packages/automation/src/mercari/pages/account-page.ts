/**
 * The seller's account page (`/mypage/`), which only a logged-in seller sees: the health check
 * opens it to show the session works. A session Mercari rejected lands on its login page
 * instead, which the runner's safety rules stop at.
 */
import type { PageDriver } from '../../runner/types.ts';
import { MERCARI_PATHS } from '../site.ts';
import { absolute, expectElement, type MercariSite } from './common.ts';

export const ACCOUNT_PAGE = {
  root: '[data-testid="MyPage"]',
} as const;

export async function openAccount(page: PageDriver, site: MercariSite): Promise<void> {
  await page.goto(absolute(site, MERCARI_PATHS.account));
  await expectElement(page, ACCOUNT_PAGE.root, 'account page', 'account section');
}

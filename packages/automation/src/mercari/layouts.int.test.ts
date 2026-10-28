/**
 * The Mercari sale check in both of Mercari's layouts of the seller's listing tabs, on the fake
 * Mercari site: the desktop table the Mac's Chrome gets, and the mobile layout the iPhone app's
 * web view gets, whose rows link to their listing only through the photo and the title, and
 * which shows placeholder rows that link to nothing while Mercari's own query runs. Each runs on
 * the cloud runner and on the phone runtime (its own page backend). A tab whose rows never draw
 * fails the check: it never reads as a tab without sales.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdapterContext } from '@listora/marketplaces';

import { AutomationReadError } from '../adapter/automation-adapter.ts';
import type { AutomationSessions } from '../adapter/sessions.ts';
import { PhoneTestSessions } from '../phone/test-host.ts';
import { automationProfile, standInProfile } from '../profiles.ts';
import { PlaywrightBrowserRunner } from '../runner/browser-runner.ts';
import { MemoryScreenshotStore } from '../runner/screenshots.ts';
import { FakeSiteSessions, QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { createMercariAutomationAdapter } from './adapter.ts';
import { FakeMercariSite, type FakeMercariLayout } from './fake/fake-mercari.ts';

/** Room for the tab's own wait for rows that never draw (8 seconds). */
const STEP_TIMEOUT_MS = 12_000;
const connection = { id: 'connection-mercari', mode: 'automation', status: 'connected' } as const;
const ctx = (): AdapterContext => ({ signal: new AbortController().signal, connection });
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

type Host = 'runner' | 'phone';

for (const layout of ['desktop', 'mobile'] as const satisfies readonly FakeMercariLayout[]) {
  for (const host of ['runner', 'phone'] as const satisfies readonly Host[]) {
    describe(`Mercari's sale check in its ${layout} layout, on the ${host}`, () => {
      let site: FakeMercariSite;
      let runner: PlaywrightBrowserRunner | undefined;
      let phone: PhoneTestSessions | undefined;
      let adapter: ReturnType<typeof createMercariAutomationAdapter>;

      beforeAll(async () => {
        site = await FakeMercariSite.start(0, { pageSize: 2, layout });
        const profile = { ...automationProfile('mercari'), pacing: QUICK_PACING };
        let sessions: AutomationSessions;
        if (host === 'phone') {
          phone = new PhoneTestSessions(
            site,
            { ...standInProfile(automationProfile('mercari'), site.url), pacing: QUICK_PACING },
            STEP_TIMEOUT_MS,
          );
          sessions = phone;
        } else {
          runner = new PlaywrightBrowserRunner({
            logger: silentLogger,
            screenshots: new MemoryScreenshotStore(),
            stepTimeoutMs: STEP_TIMEOUT_MS,
          });
          sessions = new FakeSiteSessions(site, runner, {
            ...profile,
            origins: [site.url],
            cookieDomains: ['127.0.0.1'],
          });
        }
        adapter = createMercariAutomationAdapter({
          siteUrl: site.url,
          profile,
          sessions,
          photos: stubPhotos,
          logger: silentLogger,
        });
      });

      afterAll(async () => {
        await phone?.close();
        await runner?.close();
        await site.close();
      });

      it('reads empty sales tabs as no sales once their rows have drawn', async () => {
        expect(await adapter.listOrdersSince(hoursAgo(24), ctx())).toEqual([]);
      });

      it('finds the sales waiting to ship and done, with their titles and prices', async () => {
        const waiting = site.seed({ title: 'Waiting sale', priceCents: 3200 });
        const soldAt = hoursAgo(2);
        site.sell(waiting, soldAt);
        const done = site.seed({ title: 'Done sale', priceCents: 4500 });
        site.sell(done, hoursAgo(5));
        site.complete(done);
        // More sales than a page holds: the second page's rows draw the same way.
        for (const title of ['Older sale', 'Oldest sale']) {
          site.sell(site.seed({ title, priceCents: 1000 }), hoursAgo(10));
        }
        site.seed({ title: 'Still for sale', priceCents: 1000 });

        const orders = await adapter.listOrdersSince(hoursAgo(24), ctx());
        expect(orders).toHaveLength(4);
        const sale = orders.find((order) => order.externalOrderId === waiting);
        expect(sale).toMatchObject({
          items: [{ externalListingId: waiting, title: 'Waiting sale', priceCents: 3200 }],
        });
        expect(sale?.shipped).toBeUndefined();
        // The sale's time, from its listing's page (to the second; the phone's answer is JSON).
        expect(Math.floor(new Date(sale?.soldAt ?? 0).getTime() / 1000)).toBe(
          Math.floor(soldAt.getTime() / 1000),
        );
        expect(orders.find((order) => order.externalOrderId === done)).toMatchObject({
          shipped: true,
          items: [{ externalListingId: done, title: 'Done sale', priceCents: 4500 }],
        });
      });

      it('fails the check when a tab never draws its rows, rather than finding no sales', async () => {
        site.inject({ action: 'listings', fault: { type: 'rows_never_drawn' } });
        const failure = await adapter.listOrdersSince(hoursAgo(24), ctx()).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(AutomationReadError);
        expect(failure).toMatchObject({
          code: 'element_missing',
          step: 'read the in progress sales',
        });
        site.clearFaults();
      });
    });
  }
}

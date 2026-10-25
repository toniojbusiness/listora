/**
 * The eBay automation adapter against the shared adapter conformance suite, in a real headless
 * Chromium, on the fake eBay site: create, revise, price, end, relist (a new item number),
 * read-back with revisions, no authoritative absence, error mapping, and health, with a session
 * eBay rejected falling back to the user's task. No traffic goes to eBay.
 */
import { fileURLToPath } from 'node:url';

import { describeAdapterConformance } from '@listora/marketplaces/conformance';

import { automationProfile } from '../profiles.ts';
import { PlaywrightBrowserRunner } from '../runner/browser-runner.ts';
import { MemoryScreenshotStore } from '../runner/screenshots.ts';
import { FakeSiteSessions, QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { createEbayAutomationAdapter } from './adapter.ts';
import { EBAY_STEP_TIMEOUT_MS, fakeEbaySiteConformance } from './fake/conformance-driver.ts';
import { FakeEbaySite } from './fake/fake-ebay-site.ts';

const site = await FakeEbaySite.start();
const closed = await FakeEbaySite.start();
const unreachableUrl = closed.url;
await closed.close();

const runner = new PlaywrightBrowserRunner({
  logger: silentLogger,
  screenshots: new MemoryScreenshotStore(),
  stepTimeoutMs: EBAY_STEP_TIMEOUT_MS,
});
const profile = { ...automationProfile('ebay'), pacing: QUICK_PACING };

function adapter(siteUrl: string) {
  return createEbayAutomationAdapter({
    siteUrl,
    profile,
    sessions: new FakeSiteSessions(site, runner, {
      ...profile,
      origins: [new URL(siteUrl).origin],
      cookieDomains: ['127.0.0.1'],
    }),
    photos: stubPhotos,
    logger: silentLogger,
  });
}

describeAdapterConformance({
  name: 'eBay automation adapter',
  adapter: adapter(site.url),
  connection: { id: 'connection-ebay', mode: 'automation', status: 'connected' },
  goldenDir: fileURLToPath(new URL('__golden__/', import.meta.url)),
  marketplace: fakeEbaySiteConformance(site),
  unreachable: adapter(unreachableUrl),
  teardown: async () => {
    await runner.close();
    await site.close();
  },
});

/**
 * The fake site's automation adapter against the shared adapter conformance suite, in a real
 * headless Chromium: the suite every automation adapter must pass (create, edit, price, end,
 * relist, read-back with revisions, absences, error mapping, health), with automated kinds
 * checked like API kinds and a rejected session falling back to the user's task.
 */
import { fileURLToPath } from 'node:url';

import { describeAdapterConformance } from '@listora/marketplaces/conformance';

import { automationProfile } from '../profiles.ts';
import { PlaywrightBrowserRunner } from '../runner/browser-runner.ts';
import { MemoryScreenshotStore } from '../runner/screenshots.ts';
import { FakeSiteSessions, QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { CONFORMANCE_STEP_TIMEOUT_MS, fakeSiteConformance } from './conformance-driver.ts';
import { createFakeSiteAdapter } from './fake-site-adapter.ts';
import { FakeAutomationSite } from './fake-site.ts';

const site = await FakeAutomationSite.start();
const closed = await FakeAutomationSite.start();
const unreachableUrl = closed.url;
await closed.close();

const runner = new PlaywrightBrowserRunner({
  logger: silentLogger,
  screenshots: new MemoryScreenshotStore(),
  stepTimeoutMs: CONFORMANCE_STEP_TIMEOUT_MS,
});
const profile = { ...automationProfile('mercari'), pacing: QUICK_PACING };

function adapter(siteUrl: string) {
  return createFakeSiteAdapter({
    marketplace: 'mercari',
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
  name: 'Fake site automation adapter',
  adapter: adapter(site.url),
  connection: { id: 'connection-mercari', mode: 'automation', status: 'connected' },
  goldenDir: fileURLToPath(new URL('__golden__/', import.meta.url)),
  marketplace: fakeSiteConformance(site),
  unreachable: adapter(unreachableUrl),
  teardown: async () => {
    await runner.close();
    await site.close();
  },
});

/**
 * The Depop automation adapter against the shared adapter conformance suite, in a real headless
 * Chromium, on the fake Depop site: create, edit, price, end (delete), relist (a new listing),
 * read-back without revisions (a change is confirmed by reading it twice), a deleted product's
 * 410 Gone as the one authoritative absence, error mapping, and health, with a session Depop
 * rejected falling back to the user's task. No traffic goes to Depop.
 */
import { fileURLToPath } from 'node:url';

import { describeAdapterConformance } from '@listora/marketplaces/conformance';

import { automationProfile, standInProfile } from '../profiles.ts';
import { PlaywrightBrowserRunner } from '../runner/browser-runner.ts';
import { MemoryScreenshotStore } from '../runner/screenshots.ts';
import { FakeSiteSessions, QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { createDepopAutomationAdapter } from './adapter.ts';
import { DEPOP_STEP_TIMEOUT_MS, fakeDepopSiteConformance } from './fake/conformance-driver.ts';
import { FakeDepopSite } from './fake/fake-depop-site.ts';

const site = await FakeDepopSite.start();
const closed = await FakeDepopSite.start();
const unreachableUrl = closed.url;
await closed.close();

const runner = new PlaywrightBrowserRunner({
  logger: silentLogger,
  screenshots: new MemoryScreenshotStore(),
  stepTimeoutMs: DEPOP_STEP_TIMEOUT_MS,
});
const profile = { ...automationProfile('depop'), pacing: QUICK_PACING };

function adapter(siteUrl: string) {
  return createDepopAutomationAdapter({
    siteUrl,
    profile,
    sessions: new FakeSiteSessions(site, runner, standInProfile(profile, siteUrl)),
    photos: stubPhotos,
    logger: silentLogger,
  });
}

describeAdapterConformance({
  name: 'Depop automation adapter',
  adapter: adapter(site.url),
  connection: { id: 'connection-depop', mode: 'automation', status: 'connected' },
  goldenDir: fileURLToPath(new URL('__golden__/', import.meta.url)),
  marketplace: fakeDepopSiteConformance(site),
  unreachable: adapter(unreachableUrl),
  teardown: async () => {
    await runner.close();
    await site.close();
  },
});

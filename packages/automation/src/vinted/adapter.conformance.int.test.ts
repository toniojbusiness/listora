/**
 * The Vinted automation adapter against the shared adapter conformance suite, in a real
 * headless Chromium, on the fake Vinted site: create, price, end (Hide), relist (Unhide),
 * read-back without revisions, absences, error mapping, and health, with a session Vinted
 * rejected falling back to the seller's task. No traffic goes to Vinted.
 */
import { fileURLToPath } from 'node:url';

import { describeAdapterConformance } from '@listora/marketplaces/conformance';

import { automationProfile } from '../profiles.ts';
import { PlaywrightBrowserRunner } from '../runner/browser-runner.ts';
import { MemoryScreenshotStore } from '../runner/screenshots.ts';
import { FakeSiteSessions, QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { createVintedAutomationAdapter } from './adapter.ts';
import { fakeVintedConformance, VINTED_STEP_TIMEOUT_MS } from './fake/conformance-driver.ts';
import { FakeVintedSite } from './fake/fake-vinted-site.ts';

const site = await FakeVintedSite.start();
const closed = await FakeVintedSite.start();
const unreachableUrl = closed.url;
await closed.close();

const runner = new PlaywrightBrowserRunner({
  logger: silentLogger,
  screenshots: new MemoryScreenshotStore(),
  stepTimeoutMs: VINTED_STEP_TIMEOUT_MS,
});
const profile = { ...automationProfile('vinted'), pacing: QUICK_PACING };

function adapter(siteUrl: string) {
  return createVintedAutomationAdapter({
    siteUrl,
    profile,
    sessions: new FakeSiteSessions(site, runner, {
      ...profile,
      origins: [new URL(siteUrl).origin],
      apiOrigins: [new URL(siteUrl).origin],
      cookieDomains: ['127.0.0.1'],
    }),
    photos: stubPhotos,
    logger: silentLogger,
  });
}

describeAdapterConformance({
  name: 'Vinted automation adapter',
  adapter: adapter(site.url),
  connection: { id: 'connection-vinted', mode: 'automation', status: 'connected' },
  goldenDir: fileURLToPath(new URL('__golden__/', import.meta.url)),
  marketplace: fakeVintedConformance(site),
  unreachable: adapter(unreachableUrl),
  teardown: async () => {
    await runner.close();
    await site.close();
  },
});

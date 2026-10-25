/**
 * The Mercari automation adapter against the shared adapter conformance suite, in a real
 * headless Chromium, on the fake Mercari site: create, edit, price, end (deactivate), relist
 * (activate), read-back with revisions, absences, error mapping, and health, with a session
 * Mercari rejected falling back to the user's task. No traffic goes to Mercari.
 */
import { fileURLToPath } from 'node:url';

import { describeAdapterConformance } from '@listora/marketplaces/conformance';

import { automationProfile } from '../profiles.ts';
import { PlaywrightBrowserRunner } from '../runner/browser-runner.ts';
import { MemoryScreenshotStore } from '../runner/screenshots.ts';
import { FakeSiteSessions, QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { createMercariAutomationAdapter } from './adapter.ts';
import { fakeMercariConformance, MERCARI_STEP_TIMEOUT_MS } from './fake/conformance-driver.ts';
import { FakeMercariSite } from './fake/fake-mercari.ts';

const site = await FakeMercariSite.start();
const closed = await FakeMercariSite.start();
const unreachableUrl = closed.url;
await closed.close();

const runner = new PlaywrightBrowserRunner({
  logger: silentLogger,
  screenshots: new MemoryScreenshotStore(),
  stepTimeoutMs: MERCARI_STEP_TIMEOUT_MS,
});
const profile = { ...automationProfile('mercari'), pacing: QUICK_PACING };

function adapter(siteUrl: string) {
  return createMercariAutomationAdapter({
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
  name: 'Mercari automation adapter',
  adapter: adapter(site.url),
  connection: { id: 'connection-mercari', mode: 'automation', status: 'connected' },
  goldenDir: fileURLToPath(new URL('__golden__/', import.meta.url)),
  marketplace: fakeMercariConformance(site),
  unreachable: adapter(unreachableUrl),
  teardown: async () => {
    await runner.close();
    await site.close();
  },
});

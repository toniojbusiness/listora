/**
 * The Poshmark automation adapter against the shared adapter conformance suite, in a real
 * headless Chromium on the fake Poshmark: create, edit, price, end (not for sale), relist (for
 * sale again), read-back with revisions, absences that are never authoritative, error mapping,
 * and health, with a rejected session falling back to the user's task. No real Poshmark traffic.
 */
import { fileURLToPath } from 'node:url';

import { describeAdapterConformance } from '@listora/marketplaces/conformance';

import { automationProfile, standInProfile } from '../profiles.ts';
import { PlaywrightBrowserRunner } from '../runner/browser-runner.ts';
import { MemoryScreenshotStore } from '../runner/screenshots.ts';
import { FakeSiteSessions, QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { createPoshmarkAutomationAdapter } from './adapter.ts';
import { CONFORMANCE_STEP_TIMEOUT_MS, fakePoshmarkConformance } from './fake/conformance-driver.ts';
import { FakePoshmark } from './fake/fake-poshmark.ts';

const site = await FakePoshmark.start();
const closed = await FakePoshmark.start();
const unreachableUrl = closed.url;
await closed.close();

const runner = new PlaywrightBrowserRunner({
  logger: silentLogger,
  screenshots: new MemoryScreenshotStore(),
  stepTimeoutMs: CONFORMANCE_STEP_TIMEOUT_MS,
});

function adapter(siteUrl: string) {
  const profile = {
    ...standInProfile(automationProfile('poshmark'), siteUrl),
    pacing: QUICK_PACING,
  };
  return createPoshmarkAutomationAdapter({
    profile,
    sessions: new FakeSiteSessions(site, runner, profile),
    photos: stubPhotos,
    logger: silentLogger,
  });
}

describeAdapterConformance({
  name: 'Poshmark automation adapter',
  adapter: adapter(site.url),
  connection: { id: 'connection-poshmark', mode: 'automation', status: 'connected' },
  goldenDir: fileURLToPath(new URL('__golden__/', import.meta.url)),
  marketplace: fakePoshmarkConformance(site),
  unreachable: adapter(unreachableUrl),
  teardown: async () => {
    await runner.close();
    await site.close();
  },
});

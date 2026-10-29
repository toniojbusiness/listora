/**
 * The phone runtime against the shared adapter conformance suite on Depop's fake site
 * (conformance-support.ts says what it covers).
 */
import { fileURLToPath } from 'node:url';

import { describeAdapterConformance } from '@listora/marketplaces/conformance';

import { createDepopAutomationAdapter } from '../depop/adapter.ts';
import {
  DEPOP_STEP_TIMEOUT_MS,
  fakeDepopSiteConformance,
} from '../depop/fake/conformance-driver.ts';
import { FakeDepopSite } from '../depop/fake/fake-depop-site.ts';
import { automationProfile } from '../profiles.ts';
import { QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { phoneSessions, sites, suiteSessions } from './conformance-support.ts';

const [site, unreachable] = await sites(() => FakeDepopSite.start());
const { track, teardown } = suiteSessions(site);
const adapter = (siteUrl: string) =>
  createDepopAutomationAdapter({
    siteUrl,
    profile: { ...automationProfile('depop'), pacing: QUICK_PACING },
    sessions: track(phoneSessions(site, 'depop', siteUrl, DEPOP_STEP_TIMEOUT_MS)),
    photos: stubPhotos,
    logger: silentLogger,
  });
describeAdapterConformance({
  name: 'Depop automation adapter on the phone',
  adapter: adapter(site.url),
  connection: { id: 'connection-depop', mode: 'automation', status: 'connected' },
  goldenDir: fileURLToPath(new URL('../depop/__golden__/', import.meta.url)),
  marketplace: fakeDepopSiteConformance(site),
  unreachable: adapter(unreachable),
  teardown,
});

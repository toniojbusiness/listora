/**
 * The phone runtime against the shared adapter conformance suite on Vinted's fake site
 * (conformance-support.ts says what it covers).
 */
import { fileURLToPath } from 'node:url';

import { describeAdapterConformance } from '@listora/marketplaces/conformance';

import { automationProfile } from '../profiles.ts';
import { QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { createVintedAutomationAdapter } from '../vinted/adapter.ts';
import {
  fakeVintedConformance,
  VINTED_STEP_TIMEOUT_MS,
} from '../vinted/fake/conformance-driver.ts';
import { FakeVintedSite } from '../vinted/fake/fake-vinted-site.ts';
import { phoneSessions, sites, suiteSessions } from './conformance-support.ts';

const [site, unreachable] = await sites(() => FakeVintedSite.start());
const { track, teardown } = suiteSessions(site);
const adapter = (siteUrl: string) =>
  createVintedAutomationAdapter({
    siteUrl,
    profile: { ...automationProfile('vinted'), pacing: QUICK_PACING },
    sessions: track(phoneSessions(site, 'vinted', siteUrl, VINTED_STEP_TIMEOUT_MS)),
    photos: stubPhotos,
    logger: silentLogger,
  });
describeAdapterConformance({
  name: 'Vinted automation adapter on the phone',
  adapter: adapter(site.url),
  connection: { id: 'connection-vinted', mode: 'automation', status: 'connected' },
  goldenDir: fileURLToPath(new URL('../vinted/__golden__/', import.meta.url)),
  marketplace: fakeVintedConformance(site),
  unreachable: adapter(unreachable),
  teardown,
});

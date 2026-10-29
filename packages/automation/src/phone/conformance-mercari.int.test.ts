/**
 * The phone runtime against the shared adapter conformance suite on Mercari's fake site
 * (conformance-support.ts says what it covers).
 */
import { fileURLToPath } from 'node:url';

import { describeAdapterConformance } from '@listora/marketplaces/conformance';

import { createMercariAutomationAdapter } from '../mercari/adapter.ts';
import {
  fakeMercariConformance,
  MERCARI_STEP_TIMEOUT_MS,
} from '../mercari/fake/conformance-driver.ts';
import { FakeMercariSite } from '../mercari/fake/fake-mercari.ts';
import { automationProfile } from '../profiles.ts';
import { QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { phoneSessions, sites, suiteSessions } from './conformance-support.ts';

const [site, unreachable] = await sites(() => FakeMercariSite.start());
const { track, teardown } = suiteSessions(site);
const adapter = (siteUrl: string) =>
  createMercariAutomationAdapter({
    siteUrl,
    profile: { ...automationProfile('mercari'), pacing: QUICK_PACING },
    sessions: track(phoneSessions(site, 'mercari', siteUrl, MERCARI_STEP_TIMEOUT_MS)),
    photos: stubPhotos,
    logger: silentLogger,
  });
describeAdapterConformance({
  name: 'Mercari automation adapter on the phone',
  adapter: adapter(site.url),
  connection: { id: 'connection-mercari', mode: 'automation', status: 'connected' },
  goldenDir: fileURLToPath(new URL('../mercari/__golden__/', import.meta.url)),
  marketplace: fakeMercariConformance(site),
  unreachable: adapter(unreachable),
  teardown,
});

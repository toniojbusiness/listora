/**
 * The phone runtime against the shared adapter conformance suite on the fake site's fake site
 * (conformance-support.ts says what it covers).
 */
import { fileURLToPath } from 'node:url';

import { describeAdapterConformance } from '@listora/marketplaces/conformance';

import {
  CONFORMANCE_STEP_TIMEOUT_MS as FAKE_SITE_STEP_TIMEOUT_MS,
  fakeSiteConformance,
} from '../fake-site/conformance-driver.ts';
import { createFakeSiteAdapter } from '../fake-site/fake-site-adapter.ts';
import { FakeAutomationSite } from '../fake-site/fake-site.ts';
import { automationProfile } from '../profiles.ts';
import { QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { phoneSessions, sites, suiteSessions } from './conformance-support.ts';

const [site, unreachable] = await sites(() => FakeAutomationSite.start());
const { track, teardown } = suiteSessions(site);
const adapter = (siteUrl: string) =>
  createFakeSiteAdapter({
    marketplace: 'mercari',
    siteUrl,
    profile: { ...automationProfile('mercari'), pacing: QUICK_PACING },
    sessions: track(phoneSessions(site, 'mercari', siteUrl, FAKE_SITE_STEP_TIMEOUT_MS)),
    photos: stubPhotos,
    logger: silentLogger,
  });
describeAdapterConformance({
  name: 'Fake site automation adapter on the phone',
  adapter: adapter(site.url),
  connection: { id: 'connection-mercari', mode: 'automation', status: 'connected' },
  goldenDir: fileURLToPath(new URL('../fake-site/__golden__/', import.meta.url)),
  marketplace: fakeSiteConformance(site),
  unreachable: adapter(unreachable),
  teardown,
});

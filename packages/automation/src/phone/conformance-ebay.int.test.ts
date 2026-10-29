/**
 * The phone runtime against the shared adapter conformance suite on eBay's fake site
 * (conformance-support.ts says what it covers).
 */
import { fileURLToPath } from 'node:url';

import { describeAdapterConformance } from '@listora/marketplaces/conformance';

import { createEbayAutomationAdapter } from '../ebay/adapter.ts';
import { EBAY_STEP_TIMEOUT_MS, fakeEbaySiteConformance } from '../ebay/fake/conformance-driver.ts';
import { FakeEbaySite } from '../ebay/fake/fake-ebay-site.ts';
import { automationProfile } from '../profiles.ts';
import { QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { phoneSessions, sites, suiteSessions } from './conformance-support.ts';

const [site, unreachable] = await sites(() => FakeEbaySite.start());
const { track, teardown } = suiteSessions(site);
const adapter = (siteUrl: string) =>
  createEbayAutomationAdapter({
    siteUrl,
    profile: { ...automationProfile('ebay'), pacing: QUICK_PACING },
    sessions: track(phoneSessions(site, 'ebay', siteUrl, EBAY_STEP_TIMEOUT_MS)),
    photos: stubPhotos,
    logger: silentLogger,
  });
describeAdapterConformance({
  name: 'eBay automation adapter on the phone',
  adapter: adapter(site.url),
  connection: { id: 'connection-ebay', mode: 'automation', status: 'connected' },
  goldenDir: fileURLToPath(new URL('../ebay/__golden__/', import.meta.url)),
  marketplace: fakeEbaySiteConformance(site),
  unreachable: adapter(unreachable),
  teardown,
});

/**
 * The phone runtime against the shared adapter conformance suite on Poshmark's fake site
 * (conformance-support.ts says what it covers).
 */
import { fileURLToPath } from 'node:url';

import { describeAdapterConformance } from '@listora/marketplaces/conformance';

import { createPoshmarkAutomationAdapter } from '../poshmark/adapter.ts';
import {
  CONFORMANCE_STEP_TIMEOUT_MS as POSHMARK_STEP_TIMEOUT_MS,
  fakePoshmarkConformance,
} from '../poshmark/fake/conformance-driver.ts';
import { FakePoshmark } from '../poshmark/fake/fake-poshmark.ts';
import { automationProfile, standInProfile } from '../profiles.ts';
import { QUICK_PACING, silentLogger, stubPhotos } from '../test-support.ts';
import { phoneSessions, sites, suiteSessions } from './conformance-support.ts';

const [site, unreachable] = await sites(() => FakePoshmark.start());
const { track, teardown } = suiteSessions(site);
const adapter = (siteUrl: string) =>
  createPoshmarkAutomationAdapter({
    profile: { ...standInProfile(automationProfile('poshmark'), siteUrl), pacing: QUICK_PACING },
    sessions: track(phoneSessions(site, 'poshmark', siteUrl, POSHMARK_STEP_TIMEOUT_MS)),
    photos: stubPhotos,
    logger: silentLogger,
  });
describeAdapterConformance({
  name: 'Poshmark automation adapter on the phone',
  adapter: adapter(site.url),
  connection: { id: 'connection-poshmark', mode: 'automation', status: 'connected' },
  goldenDir: fileURLToPath(new URL('../poshmark/__golden__/', import.meta.url)),
  marketplace: fakePoshmarkConformance(site),
  unreachable: adapter(unreachable),
  teardown,
});

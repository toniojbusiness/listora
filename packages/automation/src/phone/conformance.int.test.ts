/**
 * The phone runtime (docs/features/phone-execution.md) against the shared adapter conformance
 * suite, for every automated marketplace: each adapter's sessions are served by the phone's own
 * code (runtime, page backend, page functions, and the bundled marketplace scripts) in headless
 * Chromium standing in for the iPhone app's web view, on that marketplace's fake site. So the
 * phone creates, edits, reprices, ends, relists, reads back, and checks health exactly as the
 * browser runner does, and maps every failure the same way. The app's own web view is tested on
 * the simulator against the local stack (PhoneExecutionUITests).
 */
import { fileURLToPath } from 'node:url';

import { describeAdapterConformance } from '@listora/marketplaces/conformance';

import { createDepopAutomationAdapter } from '../depop/adapter.ts';
import {
  DEPOP_STEP_TIMEOUT_MS,
  fakeDepopSiteConformance,
} from '../depop/fake/conformance-driver.ts';
import { FakeDepopSite } from '../depop/fake/fake-depop-site.ts';
import { createEbayAutomationAdapter } from '../ebay/adapter.ts';
import { EBAY_STEP_TIMEOUT_MS, fakeEbaySiteConformance } from '../ebay/fake/conformance-driver.ts';
import { FakeEbaySite } from '../ebay/fake/fake-ebay-site.ts';
import {
  CONFORMANCE_STEP_TIMEOUT_MS as FAKE_SITE_STEP_TIMEOUT_MS,
  fakeSiteConformance,
} from '../fake-site/conformance-driver.ts';
import { createFakeSiteAdapter } from '../fake-site/fake-site-adapter.ts';
import { FakeAutomationSite } from '../fake-site/fake-site.ts';
import { createMercariAutomationAdapter } from '../mercari/adapter.ts';
import {
  fakeMercariConformance,
  MERCARI_STEP_TIMEOUT_MS,
} from '../mercari/fake/conformance-driver.ts';
import { FakeMercariSite } from '../mercari/fake/fake-mercari.ts';
import { createPoshmarkAutomationAdapter } from '../poshmark/adapter.ts';
import {
  CONFORMANCE_STEP_TIMEOUT_MS as POSHMARK_STEP_TIMEOUT_MS,
  fakePoshmarkConformance,
} from '../poshmark/fake/conformance-driver.ts';
import { FakePoshmark } from '../poshmark/fake/fake-poshmark.ts';
import { automationProfile, standInProfile, type AutomatedMarketplace } from '../profiles.ts';
import { QUICK_PACING, silentLogger, stubPhotos, type SessionIssuer } from '../test-support.ts';
import { PhoneTestSessions } from './test-host.ts';

interface FakeSite extends SessionIssuer {
  url: string;
  close(): Promise<void>;
}

/** A started fake site, and the URL of one that no longer answers. */
async function sites<T extends FakeSite>(start: () => Promise<T>): Promise<[T, string]> {
  const site = await start();
  const closed = await start();
  const unreachable = closed.url;
  await closed.close();
  return [site, unreachable];
}

function phoneSessions(
  site: SessionIssuer,
  marketplace: AutomatedMarketplace,
  siteUrl: string,
  stepTimeoutMs: number,
): PhoneTestSessions {
  const profile = {
    ...standInProfile(automationProfile(marketplace), siteUrl),
    pacing: QUICK_PACING,
  };
  return new PhoneTestSessions(site, profile, stepTimeoutMs);
}

/** Each suite's phone sessions, closed with its site when the suite ends. */
function suiteSessions(site: FakeSite) {
  const opened: PhoneTestSessions[] = [];
  const track = (sessions: PhoneTestSessions): PhoneTestSessions => {
    opened.push(sessions);
    return sessions;
  };
  const teardown = async (): Promise<void> => {
    for (const sessions of opened) await sessions.close();
    await site.close();
  };
  return { track, teardown };
}

{
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
}

{
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
}

{
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
}

{
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
}

{
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
}

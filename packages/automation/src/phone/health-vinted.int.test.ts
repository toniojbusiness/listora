/**
 * Vinted's session check through the phone runtime (Vinted plan M3): Vinted runs only on the
 * seller's iPhone, so its check is the bundled Vinted scripts in the phone's page backend, in
 * headless Chromium standing in for the app's web view, on the fake Vinted site. It reads the
 * member as the browser runner does, and stops at Vinted's checks for the seller to complete.
 * Vinted has no listing scripts yet, so it has no conformance suite of its own
 * (conformance-<marketplace>).
 */
import { afterAll, describe, expect, it } from 'vitest';

import type { AdapterContext } from '@listora/marketplaces';

import { automationProfile } from '../profiles.ts';
import { QUICK_PACING, silentLogger } from '../test-support.ts';
import { createVintedAutomationAdapter } from '../vinted/adapter.ts';
import { FakeVintedSite } from '../vinted/fake/fake-vinted-site.ts';
import { phoneSessions, sites, suiteSessions } from './conformance-support.ts';

const connection = { id: 'connection-vinted', mode: 'automation', status: 'connected' } as const;
const ctx = (): AdapterContext => ({ signal: new AbortController().signal, connection });

const [site, unreachable] = await sites(() => FakeVintedSite.start());
const { track, teardown } = suiteSessions(site);
const issuer = { issueSession: () => site.issueSession('Phone.Member') };
const adapter = (siteUrl: string) =>
  createVintedAutomationAdapter({
    siteUrl,
    profile: { ...automationProfile('vinted'), pacing: QUICK_PACING },
    sessions: track(phoneSessions(issuer, 'vinted', siteUrl, 3_000)),
    logger: silentLogger,
  });

describe('Vinted session check on the phone', () => {
  afterAll(teardown, 60_000);

  it('passes and reads the member signed in', async () => {
    expect(await adapter(site.url).healthCheck(ctx())).toEqual({
      status: 'ok',
      sellerId: 'phone.member',
    });
  });

  it('stops at DataDome, which the phone hands to the seller, and keeps the session', async () => {
    site.injectFault({ action: 'health', fault: { type: 'datadome' } });
    // The phone stops for the seller to complete the check themselves (the test host's seller
    // declines), so the check is tried again later; Listora never passes it.
    expect(await adapter(site.url).healthCheck(ctx())).toMatchObject({
      status: 'degraded',
      code: 'stopped_for_check',
    });
  });

  it('cannot check a site that does not answer, and keeps the session', async () => {
    expect(await adapter(unreachable).healthCheck(ctx())).toMatchObject({ status: 'degraded' });
  });
});

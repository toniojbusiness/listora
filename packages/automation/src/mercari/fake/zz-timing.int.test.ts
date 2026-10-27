import { appendFileSync } from 'node:fs';

import { it } from 'vitest';

const log = (...parts: unknown[]): void => { appendFileSync('/tmp/timing-out.log', parts.map(String).join(' ') + '\n'); };

import { desiredStateForContent } from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import { automationProfile, standInProfile } from '../../profiles.ts';
import { PhoneTestSessions } from '../../phone/test-host.ts';
import { QUICK_PACING, silentLogger, stubPhotos } from '../../test-support.ts';
import { createMercariAutomationAdapter } from '../adapter.ts';
import { MERCARI_STEP_TIMEOUT_MS } from './conformance-driver.ts';
import { FakeMercariSite } from './fake-mercari.ts';

it('times the phone timeout case', async () => {
  const site = await FakeMercariSite.start();
  const profile = {
    ...standInProfile(automationProfile('mercari'), site.url),
    pacing: QUICK_PACING,
  };
  const sessions = new PhoneTestSessions(site, profile, MERCARI_STEP_TIMEOUT_MS);
  const adapter = createMercariAutomationAdapter({
    siteUrl: site.url,
    profile: { ...automationProfile('mercari'), pacing: QUICK_PACING },
    sessions,
    photos: stubPhotos,
    logger: silentLogger,
  });
  const content = sampleListingContent();
  const listing = {
    listingId: 'timing-1',
    externalListingId: null,
    externalSku: 'SKU-timing-1',
    externalUrl: null,
  };
  site.inject({ action: 'create', fault: { type: 'slow', delayMs: 20_000, afterApply: true } });
  const start = Date.now();
  const outcome = await adapter.execute(
    {
      operationId: 'op',
      kind: 'create',
      idempotencyKey: 'key',
      attempt: 1,
      listing,
      desired: desiredStateForContent('create', content),
      payload: adapter.buildPayload(content.item, content.variant),
    },
    { signal: new AbortController().signal, connection: { id: 'c', mode: 'automation', status: 'connected' } },
  );
  const executed = Date.now();
  const read = await adapter.readListing(listing, {
    signal: new AbortController().signal,
    connection: { id: 'c', mode: 'automation', status: 'connected' },
  });
  const done = Date.now();
  log('outcome', outcome.type, 'read found', read.found);
  log('execute ms', executed - start, 'read ms', done - executed);
  for (const host of sessions.hosts) {
    log('steps', JSON.stringify(host.steps));
  }
  for (const request of site.requests) {
    log(request.at - start, request.method, request.path, request.status);
  }
  await sessions.close();
  await site.close();
}, 90_000);

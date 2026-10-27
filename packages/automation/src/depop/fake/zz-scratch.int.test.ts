import { appendFileSync } from 'node:fs';

import { it } from 'vitest';

const log = (...parts: unknown[]) => { appendFileSync('/tmp/depop-scratch/trace.log', parts.map(String).join(' ') + '\n'); };

import { desiredStateForContent } from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import { automationProfile, standInProfile } from '../../profiles.ts';
import { PhoneTestSessions } from '../../phone/test-host.ts';
import { QUICK_PACING, silentLogger, stubPhotos } from '../../test-support.ts';
import { createDepopAutomationAdapter } from '../adapter.ts';
import { DEPOP_STEP_TIMEOUT_MS } from './conformance-driver.ts';
import { FakeDepopSite } from './fake-depop-site.ts';

it('times the phone timeout-after-send flow', { timeout: 120_000 }, async () => {
  const site = await FakeDepopSite.start();
  const sessions = new PhoneTestSessions(
    site,
    { ...standInProfile(automationProfile('depop'), site.url), pacing: QUICK_PACING },
    DEPOP_STEP_TIMEOUT_MS,
  );
  let traced = false;
  sessions.prepare = (host) => {
    host.defaultAnswer = 'declined';
    if (!traced) return;
    for (const name of ['evaluate', 'settle', 'navigate', 'state', 'pageData'] as const) {
      const original = (host as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name]!.bind(host);
      (host as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
        const began = Date.now();
        const what = name === 'evaluate' ? String(args[0]).split('\n').slice(-3).join(' ').slice(0, 60) : name === 'pageData' ? String(args[0]) : '';
        try {
          const value = await original(...args);
          log('host', name, Date.now() - began, 'ms', what);
          return value;
        } catch (error) {
          log('host', name, Date.now() - began, 'ms FAILED', String(error), what);
          throw error;
        }
      };
    }
  };
  const adapter = createDepopAutomationAdapter({
    siteUrl: site.url,
    profile: { ...automationProfile('depop'), pacing: QUICK_PACING },
    sessions,
    photos: stubPhotos,
    logger: silentLogger,
  });
  const ctx = () => ({ signal: new AbortController().signal, connection: { id: 'c', mode: 'automation', status: 'connected' } as const });
  const content = sampleListingContent();
  const ref = { listingId: 'scratch-1', externalListingId: null, externalSku: 'SKU-scratch-1', externalUrl: null };
  const op = {
    operationId: 'op-scratch', kind: 'create' as const, idempotencyKey: 'k', attempt: 1, listing: ref,
    desired: desiredStateForContent('create', content),
    payload: adapter.buildPayload(content.item, content.variant),
  };
  const start = Date.now();
  // A warm-up create, as the suite has made listings before this check.
  await adapter.execute({ ...op, operationId: 'warm', listing: { ...ref, listingId: 'w', externalSku: 'SKU-w' } }, ctx());
  log('warm-up create', Date.now() - start);
  site.inject({ action: 'create', fault: { type: 'slow', delayMs: 20_000, afterApply: true } });
  traced = true;
  const t0 = Date.now();
  const outcome = await adapter.execute(op, ctx());
  log('create', Date.now() - t0, JSON.stringify(outcome).slice(0, 300));
  const host = sessions.hosts.at(-1);
  log('steps', JSON.stringify(host?.steps));
  traced = false;
  const t1 = Date.now();
  const read = await adapter.readListing(ref, ctx());
  log('read', Date.now() - t1, JSON.stringify(read).slice(0, 200));
  for (const request of site.requests.slice(-30)) log(request.at - t0, request.method, request.path, request.status);
  await sessions.close();
  await site.close();
});

import { appendFileSync } from 'node:fs';

import { it } from 'vitest';

import { desiredStateForContent } from '@listora/marketplaces';
import { sampleListingContent } from '@listora/marketplaces/testing';

import { automationProfile } from '../../profiles.ts';
import { PlaywrightBrowserRunner } from '../../runner/browser-runner.ts';
import { MemoryScreenshotStore } from '../../runner/screenshots.ts';
import { FakeSiteSessions, QUICK_PACING, silentLogger, stubPhotos } from '../../test-support.ts';
import { createDepopAutomationAdapter } from '../adapter.ts';
import { DEPOP_STEP_TIMEOUT_MS } from './conformance-driver.ts';
import { FakeDepopSite } from './fake-depop-site.ts';

const log = (...parts: unknown[]) => {
  appendFileSync('/tmp/depop-scratch/relist.log', `${parts.map(String).join(' ')}\n`);
};

it('relists a listing whose page answers 410 after its end', { timeout: 120_000 }, async () => {
  const site = await FakeDepopSite.start();
  const runner = new PlaywrightBrowserRunner({ logger: silentLogger, screenshots: new MemoryScreenshotStore(), stepTimeoutMs: DEPOP_STEP_TIMEOUT_MS });
  const profile = { ...automationProfile('depop'), pacing: QUICK_PACING };
  const sessions = new FakeSiteSessions(site, runner, { ...profile, origins: [site.url], cookieDomains: ['127.0.0.1'] });
  const adapter = createDepopAutomationAdapter({ siteUrl: site.url, profile, sessions, photos: stubPhotos, logger: silentLogger });
  const ctx = () => ({ signal: new AbortController().signal, connection: { id: 'c', mode: 'automation', status: 'connected' } as const });
  const content = sampleListingContent();
  const ref = { listingId: 'r1', externalListingId: null, externalSku: 'SKU-r1', externalUrl: null };
  const base = { idempotencyKey: 'k', attempt: 1 };
  const created = await adapter.execute({ ...base, operationId: 'c', kind: 'create', listing: ref, desired: desiredStateForContent('create', content), payload: adapter.buildPayload(content.item, content.variant) }, ctx());
  const slug = created.type === 'confirmed' ? (created.externalListingId ?? '') : '';
  const listed = { ...ref, externalListingId: slug };
  const ended = await adapter.execute({ ...base, operationId: 'e', kind: 'end', listing: listed, desired: { status: 'ended' }, payload: null }, ctx());
  log('end', JSON.stringify(ended).slice(0, 120));
  // What Depop's page did for a real listing Listora deleted (product-page.ts): 410 Gone.
  site.gone(slug);
  log('read', JSON.stringify(await adapter.readListing(listed, ctx())));
  const relisted = await adapter.execute({ ...base, operationId: 'r', kind: 'relist', listing: listed, desired: desiredStateForContent('relist', content), payload: adapter.buildPayload(content.item, content.variant) }, ctx());
  log('relist', JSON.stringify(relisted).slice(0, 300));
  const priced = await adapter.execute({ ...base, operationId: 'p', kind: 'price', listing: listed, desired: { priceCents: 3900, currency: 'USD' }, payload: null }, ctx());
  log('price', JSON.stringify(priced).slice(0, 300));
  await runner.close();
  await site.close();
});

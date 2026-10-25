/**
 * The eBay sandbox check: the adapter against eBay's real sandbox, end to end. Run it with
 * `npm run ebay:sandbox-check` once the keys are in `.env` (README.md, "eBay sandbox check").
 * It skips by itself without them (as in `npm run check` and CI); through the npm command,
 * missing keys fail it with what to set.
 *
 * It checks: both OAuth grants; that every mapped category is still a leaf and what its Size
 * values are (written to `.local/ebay-sandbox-check.json`, to refresh the fake's fixtures);
 * the health check; preparing a listing (item specifics and VerifyAddFixedPriceItem); and one
 * listing's whole life: create (with a photo copied into EPS), the UUID's duplicate protection,
 * read-back by SKU and by id, a price change, an end, ending again, and a relist. Every listing
 * it creates is ended before it finishes. It uses about 15 Trading calls.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdapterContext, ListingRef, OperationRequest } from '../adapter.ts';
import { desiredStateForContent, type ListingContent } from '../content.ts';
import { sampleListingContent } from '../testing.ts';
import { ebayUuid, type EbayAdapter } from './adapter.ts';
import { mappedEbayCategories } from './categories.ts';
import { loadEbayConfig, type EbayConfig } from './config.ts';
import { createEbayAdapter } from './create.ts';
import { ApplicationToken, EbayOAuthClient } from './oauth.ts';
import type { EbayListingPayload } from './payload.ts';
import { getItemAspectsForCategory } from './rest.ts';

const REQUIRED = ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_USER_REFRESH_TOKEN'] as const;
const missing = REQUIRED.filter((key) => (process.env[key] ?? '') === '');
const required = process.env['EBAY_SANDBOX_CHECK'] === 'required';
const ready = missing.length === 0;

/** A public-domain photo eBay can fetch over https (override with EBAY_SANDBOX_PHOTO_URL). */
const PHOTO_URL =
  process.env['EBAY_SANDBOX_PHOTO_URL'] ??
  'https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg';
const REPORT = new URL('../../../../.local/ebay-sandbox-check.json', import.meta.url);

describe.runIf(required && !ready)('eBay sandbox check: keys', () => {
  it('has the keys it needs', () => {
    expect.fail(
      `Set ${missing.join(', ')} in .env (see .env.example, "eBay"). The application keys are ` +
        "the sandbox keyset's App ID and Cert ID (developer.ebay.com > My Account > Application " +
        'Keys); the refresh token comes from signing in a sandbox test user (README.md, "eBay ' +
        'sandbox check").',
    );
  });
});

describe.runIf(ready)('eBay sandbox check', { timeout: 120_000 }, () => {
  // Built when the suite runs: without keys it is skipped, and its body only collects tests.
  let config: EbayConfig;
  let adapter: EbayAdapter;
  beforeAll(() => {
    config = sandboxConfig();
    adapter = createEbayAdapter(config, { requestTimeoutMs: 60_000 });
  });
  const ctx = (): AdapterContext => ({
    signal: AbortSignal.timeout(110_000),
    connection: { id: 'sandbox-check', mode: 'api' },
  });
  const runId = String(Date.now());
  const live = new Set<string>();
  const report: Record<string, unknown> = { checkedAt: new Date().toISOString() };

  afterAll(async () => {
    for (const externalListingId of live) {
      await adapter.execute(op('end', { ...ref('cleanup'), externalListingId }), ctx());
    }
    mkdirSync(new URL('.', REPORT), { recursive: true });
    writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  });

  const content: ListingContent = sampleListingContent({
    item: {
      sku: `LST-CHECK-${runId}`,
      photos: [{ photoId: 'photo-1', position: 0, role: 'front', url: PHOTO_URL }],
    },
    variant: { title: `Listora sandbox check ${runId} - test listing, do not buy`, aspects: [] },
  });

  function ref(name: string): ListingRef {
    return {
      listingId: `sandbox-check-${runId}-${name}`,
      externalListingId: null,
      externalSku: `LST-CHECK-${runId}-${name}`,
      externalUrl: null,
    };
  }

  function op(
    kind: 'create' | 'price' | 'end' | 'relist',
    listing: ListingRef,
    payload: EbayListingPayload | null = null,
  ): OperationRequest<EbayListingPayload> {
    return {
      operationId: `sandbox-check-${runId}-${kind}`,
      kind,
      idempotencyKey: `sandbox-check-${runId}-${listing.listingId}-${kind}`,
      attempt: 1,
      listing,
      desired:
        kind === 'price'
          ? { priceCents: 3900, currency: 'USD' }
          : kind === 'end'
            ? { status: 'ended' }
            : { status: 'active' },
      payload,
    };
  }

  it('gets an application token and a user token', async () => {
    const oauth = new EbayOAuthClient({
      tokenUrl: config.endpoints.oauthToken,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
    await expect(new ApplicationToken(oauth).get(ctx().signal)).resolves.toEqual(
      expect.any(String),
    );
    expect(await adapter.healthCheck(ctx())).toEqual({ status: 'ok' });
  });

  it('finds every mapped category still a leaf, and records its standard sizes', async () => {
    const oauth = new EbayOAuthClient({
      tokenUrl: config.endpoints.oauthToken,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
    const token = await new ApplicationToken(oauth).get(ctx().signal);
    const sizes: Record<string, unknown> = {};
    const refused: string[] = [];
    for (const category of mappedEbayCategories()) {
      const result = await getItemAspectsForCategory(
        { api: config.endpoints.api, media: config.endpoints.media },
        category.categoryId,
        { token, signal: ctx().signal, timeoutMs: 30_000 },
      );
      if (result.type !== 'ok') {
        refused.push(`${category.categoryId} ${category.name}: ${JSON.stringify(result)}`);
        continue;
      }
      sizes[`${category.categoryId} ${category.branch} > ${category.name}`] = result.value
        .filter((aspect) => /size|inseam|waist/i.test(aspect.name))
        .map(({ name, required: isRequired, mode, values }) => ({
          name,
          required: isRequired,
          mode,
          values,
        }));
    }
    report['categoryAspects'] = sizes;
    expect(refused).toEqual([]);
  });

  it('prepares the listing: item specifics and eBay’s own dry run', async () => {
    const prepared = await adapter.prepareListing(content, ctx());
    report['preparation'] = prepared;
    expect(prepared).toMatchObject({ type: 'prepared', issues: [] });
  });

  it('lists, applies a repeat once, reads back, changes the price, ends, and relists', async () => {
    const prepared = await adapter.prepareListing(content, ctx());
    if (prepared.type !== 'prepared') throw new Error(JSON.stringify(prepared));
    const payload = adapter.buildPayload(content.item, prepared.variant);
    expect(adapter.validate(payload)).toEqual([]);
    const listing = ref('lifecycle');

    const created = await adapter.execute(op('create', listing, payload), ctx());
    expect(created).toMatchObject({
      type: 'confirmed',
      externalListingId: expect.any(String) as string,
    });
    const itemId = created.type === 'confirmed' ? (created.externalListingId ?? '') : '';
    live.add(itemId);
    report['listing'] = { itemId, uuid: ebayUuid(op('create', listing).idempotencyKey) };

    // The same operation sent again: eBay's UUID duplicate protection names the same listing.
    expect(
      await adapter.execute({ ...op('create', listing, payload), attempt: 2 }, ctx()),
    ).toMatchObject({
      type: 'confirmed',
      externalListingId: itemId,
    });

    const desired = desiredStateForContent('create', {
      item: content.item,
      variant: prepared.variant,
    });
    const bySku = await adapter.readListing(listing, ctx());
    const byId = await adapter.readListing({ ...listing, externalListingId: itemId }, ctx());
    expect(bySku).toMatchObject({ ...desired, externalListingId: itemId, revision: null });
    expect(byId).toEqual(bySku);

    const withId = { ...listing, externalListingId: itemId };
    expect(await adapter.execute(op('price', withId), ctx())).toMatchObject({ type: 'confirmed' });
    expect(await adapter.readListing(withId, ctx())).toMatchObject({
      priceCents: 3900,
      status: 'active',
    });

    expect(await adapter.execute(op('end', withId), ctx())).toMatchObject({ type: 'confirmed' });
    live.delete(itemId);
    expect(await adapter.readListing(withId, ctx())).toMatchObject({ status: 'ended' });
    // Ending it again: eBay refuses, and the adapter leaves the answer to the read-back.
    expect(await adapter.execute({ ...op('end', withId), attempt: 2 }, ctx())).toMatchObject({
      type: 'confirmed',
    });

    const relisted = await adapter.execute(op('relist', withId, payload), ctx());
    expect(relisted).toMatchObject({
      type: 'confirmed',
      externalListingId: expect.any(String) as string,
    });
    const relistedId = relisted.type === 'confirmed' ? (relisted.externalListingId ?? '') : '';
    expect(relistedId).not.toBe(itemId);
    live.add(relistedId);
    expect(
      await adapter.readListing({ ...listing, externalListingId: relistedId }, ctx()),
    ).toMatchObject({
      status: 'active',
    });
  });

  it('reads an id eBay never issued as absent, but not definitively by SKU', async () => {
    expect(await adapter.readListing(ref('never-listed'), ctx())).toEqual({
      found: false,
      authoritative: false,
    });
  });
});

function sandboxConfig(): EbayConfig {
  const config = loadEbayConfig({ ...process.env, EBAY_ENV: 'sandbox' });
  if (config === undefined) throw new Error('EBAY_ENV=sandbox gives a configuration');
  return config;
}

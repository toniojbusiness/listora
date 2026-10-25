import { describe, expect, it } from 'vitest';

import type { ConnectionRef } from './adapter.ts';
import { createDepopAssistedAdapter, createPoshmarkAdapter } from './assisted/marketplaces.ts';
import { ConnectionAwareAdapter } from './connection-aware.ts';
import { FakeMarketplaceAdapter } from './fake/fake-adapter.ts';
import { sampleListingContent } from './testing.ts';

const api: ConnectionRef = { id: 'connection-1', mode: 'api' };
const assistedConnection: ConnectionRef = { id: 'connection-1', mode: 'assisted' };

describe('ConnectionAwareAdapter', () => {
  const assisted = createDepopAssistedAdapter();
  const fake = new FakeMarketplaceAdapter({ marketplace: 'depop', baseUrl: 'http://127.0.0.1:1' });
  const depop = new ConnectionAwareAdapter({ assisted, api: fake });

  it('serves a listing assisted until its connection switches to the api', () => {
    expect(depop.adapterFor(null)).toBe(assisted);
    expect(depop.adapterFor(assistedConnection)).toBe(assisted);
    expect(depop.adapterFor(api)).toBe(fake);
    expect(depop.capabilities(assistedConnection).verifyRead).toBe('user_confirm');
    expect(depop.capabilities(api).verifyRead).toBe('api');
  });

  it('builds the payload for the mode the connection is in', () => {
    const { item, variant } = sampleListingContent();
    expect(depop.buildPayload(item, variant, null)).toEqual(assisted.buildPayload(item, variant));
    expect(depop.buildPayload(item, variant, api)).toEqual(fake.buildPayload(item, variant));
  });

  it('stays assisted under an api connection when no api adapter is configured', () => {
    const unapproved = new ConnectionAwareAdapter({ assisted });
    expect(unapproved.adapterFor(api)).toBe(assisted);
    expect(unapproved.capabilities(api).create).toBe('assisted');
  });

  it('asks only the api adapter for the id of a new listing, under an api connection', () => {
    const { item } = sampleListingContent();
    const named = new ConnectionAwareAdapter({
      assisted,
      api: Object.assign(Object.create(fake) as FakeMarketplaceAdapter, {
        newListingId: (_item: unknown, used: readonly string[]) => `SKU-${String(used.length)}`,
      }),
    });
    expect(named.newListingId(item, ['a', 'b'], api)).toBe('SKU-2');
    expect(named.newListingId(item, ['a', 'b'], assistedConnection)).toBeNull();
    expect(named.newListingId(item, [], null)).toBeNull();
    // An api adapter that names nothing itself leaves the id to the marketplace.
    expect(depop.newListingId(item, [], api)).toBeNull();
  });

  it('refuses adapters for two different marketplaces', () => {
    expect(
      () => new ConnectionAwareAdapter({ assisted: createPoshmarkAdapter(), api: fake }),
    ).toThrow('api adapter is for depop, assisted adapter for poshmark');
  });
});

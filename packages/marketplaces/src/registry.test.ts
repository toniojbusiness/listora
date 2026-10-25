import { describe, expect, it } from 'vitest';

import type { ConnectionRef, MarketplaceCapabilities } from './adapter.ts';
import { AssistedAdapter } from './assisted/assisted-adapter.ts';
import {
  createDepopAssistedAdapter,
  createMercariAdapter,
  createPoshmarkAdapter,
} from './assisted/marketplaces.ts';
import { ConnectionAwareAdapter } from './connection-aware.ts';
import { FakeMarketplaceAdapter } from './fake/fake-adapter.ts';
import { AdapterRegistryError, createAdapterRegistry } from './registry.ts';

const fakeEbay = (): FakeMarketplaceAdapter =>
  new FakeMarketplaceAdapter({ marketplace: 'ebay', baseUrl: 'http://127.0.0.1:1' });

describe('createAdapterRegistry', () => {
  it('looks adapters up by marketplace, in registration order', () => {
    const ebay = fakeEbay();
    const poshmark = createPoshmarkAdapter();
    const registry = createAdapterRegistry([ebay, poshmark]);
    expect(registry.marketplaces).toEqual(['ebay', 'poshmark']);
    expect(registry.get('ebay')).toBe(ebay);
    expect(registry.lookup('poshmark')).toBe(poshmark);
    expect(registry.get('mercari')).toBeUndefined();
    expect(registry.capabilities('mercari', null)).toBeUndefined();
  });

  it('answers capabilities under a connection, which may switch the mode', () => {
    const depop = new ConnectionAwareAdapter({
      assisted: createDepopAssistedAdapter(),
      api: new FakeMarketplaceAdapter({ marketplace: 'depop', baseUrl: 'http://127.0.0.1:1' }),
    });
    const registry = createAdapterRegistry([depop, createMercariAdapter()]);
    expect(registry.capabilities('depop', null)).toMatchObject({
      create: 'assisted',
      verifyRead: 'user_confirm',
    });
    expect(
      registry.capabilities('depop', { id: 'c1', mode: 'assisted', status: 'connected' }),
    ).toMatchObject({
      create: 'assisted',
    });
    expect(
      registry.capabilities('depop', { id: 'c1', mode: 'api', status: 'connected' }),
    ).toMatchObject({
      create: 'api',
      verifyRead: 'api',
    });
  });

  it('refuses two adapters for one marketplace', () => {
    expect(() => createAdapterRegistry([fakeEbay(), fakeEbay()])).toThrow(
      new AdapterRegistryError('ebay has more than one adapter'),
    );
  });

  it('refuses an adapter whose capabilities could promise an unverifiable success', () => {
    class Incoherent extends AssistedAdapter {
      override capabilities(connection?: ConnectionRef | null): MarketplaceCapabilities {
        const base = super.capabilities();
        return connection?.mode === 'api' ? { ...base, delist: 'api' } : base;
      }
    }
    const incoherent = new Incoherent({
      marketplace: 'poshmark',
      siteUrl: 'https://poshmark.com/',
    });
    expect(() => createAdapterRegistry([incoherent])).toThrow(
      /poshmark capabilities with an api connection \(connected\) are incoherent: delist is api/,
    );
  });
});

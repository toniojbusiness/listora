/**
 * The adapters a process runs with, keyed by marketplace. The worker hands `lookup` to the
 * operation engine; the API asks it for each marketplace's capabilities under a connection.
 */
import { CONNECTION_MODES, CONNECTION_STATUSES, type Marketplace } from '@listora/db';

import type {
  AdapterLookup,
  ConnectionRef,
  MarketplaceAdapter,
  MarketplaceCapabilities,
} from './adapter.ts';
import { checkCapabilities } from './capabilities.ts';

export interface AdapterRegistry {
  /** The marketplaces that have an adapter, in registration order. */
  readonly marketplaces: readonly Marketplace[];
  get(marketplace: Marketplace): MarketplaceAdapter | undefined;
  /** `get` as the engine's `AdapterLookup`. */
  readonly lookup: AdapterLookup;
  /** The capabilities under a connection; `undefined` when the marketplace has no adapter. */
  capabilities(
    marketplace: Marketplace,
    connection: ConnectionRef | null,
  ): MarketplaceCapabilities | undefined;
}

export class AdapterRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterRegistryError';
  }
}

/**
 * Registers one adapter per marketplace. Throws when a marketplace is registered twice or an
 * adapter's capabilities contradict each other, without a connection or under any kind and
 * status of connection, so a misconfigured process fails at startup rather than mid-operation.
 */
export function createAdapterRegistry(adapters: readonly MarketplaceAdapter[]): AdapterRegistry {
  const byMarketplace = new Map<Marketplace, MarketplaceAdapter>();
  for (const adapter of adapters) {
    if (byMarketplace.has(adapter.id)) {
      throw new AdapterRegistryError(`${adapter.id} has more than one adapter`);
    }
    const probes: (ConnectionRef | null)[] = [
      null,
      ...CONNECTION_MODES.flatMap((mode) =>
        CONNECTION_STATUSES.map((status) => ({ id: `probe-${mode}-${status}`, mode, status })),
      ),
    ];
    for (const connection of probes) {
      const problems = checkCapabilities(adapter.capabilities(connection));
      if (problems.length > 0) {
        const under =
          connection === null
            ? 'without a connection'
            : `with an ${connection.mode} connection (${connection.status})`;
        throw new AdapterRegistryError(
          `${adapter.id} capabilities ${under} are incoherent: ${problems.join('; ')}`,
        );
      }
    }
    byMarketplace.set(adapter.id, adapter);
  }
  const get = (marketplace: Marketplace): MarketplaceAdapter | undefined =>
    byMarketplace.get(marketplace);
  return {
    marketplaces: [...byMarketplace.keys()],
    get,
    lookup: get,
    capabilities: (marketplace, connection) => get(marketplace)?.capabilities(connection),
  };
}

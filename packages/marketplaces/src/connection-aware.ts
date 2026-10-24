/**
 * One marketplace served in two modes, picked per connection (docs/architecture.md section 4):
 * Depop runs assisted until Listora's partner access is granted and the seller connects its
 * API, then through the API. Both modes read and write the same `marketplace_listing` rows, so
 * the switch is a change to the connection's `mode` and needs no data migration; each attempt
 * builds its payload under the connection it runs with.
 */
import type { Marketplace } from '@listora/db';

import type {
  AdapterContext,
  ConnectionRef,
  Health,
  ListingPayload,
  ListingRef,
  MarketplaceAdapter,
  MarketplaceCapabilities,
  OperationRequest,
  Outcome,
  RemoteListingState,
  ValidationIssue,
} from './adapter.ts';
import type { ItemSnapshot, ListingVariant } from './content.ts';

export interface ConnectionAwareAdapterOptions {
  /** Serves listings without a connection, or under an assisted one. */
  assisted: MarketplaceAdapter;
  /**
   * Serves listings under an `api` connection. Without it (no API adapter configured yet), those
   * listings are served assisted too: the user does the step, which is always honest.
   */
  api?: MarketplaceAdapter;
}

export class ConnectionAwareAdapter implements MarketplaceAdapter {
  readonly id: Marketplace;
  readonly #assisted: MarketplaceAdapter;
  readonly #api: MarketplaceAdapter | undefined;

  constructor(options: ConnectionAwareAdapterOptions) {
    const { assisted, api } = options;
    if (api !== undefined && api.id !== assisted.id) {
      throw new Error(`api adapter is for ${api.id}, assisted adapter for ${assisted.id}`);
    }
    this.id = assisted.id;
    this.#assisted = assisted;
    this.#api = api;
  }

  /** The adapter that serves a connection. */
  adapterFor(connection: ConnectionRef | null | undefined): MarketplaceAdapter {
    return connection?.mode === 'api' && this.#api !== undefined ? this.#api : this.#assisted;
  }

  capabilities(connection?: ConnectionRef | null): MarketplaceCapabilities {
    return this.adapterFor(connection).capabilities(connection);
  }

  buildPayload(
    item: ItemSnapshot,
    variant: ListingVariant,
    connection: ConnectionRef | null,
  ): ListingPayload {
    return this.adapterFor(connection).buildPayload(item, variant, connection);
  }

  validate(payload: ListingPayload, connection: ConnectionRef | null): ValidationIssue[] {
    return this.adapterFor(connection).validate(payload, connection);
  }

  execute(op: OperationRequest, ctx: AdapterContext): Promise<Outcome> {
    return this.adapterFor(ctx.connection).execute(op, ctx);
  }

  readListing(ref: ListingRef, ctx: AdapterContext): Promise<RemoteListingState> {
    return this.adapterFor(ctx.connection).readListing(ref, ctx);
  }

  healthCheck(ctx: AdapterContext): Promise<Health> {
    return this.adapterFor(ctx.connection).healthCheck(ctx);
  }
}

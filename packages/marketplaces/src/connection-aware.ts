/**
 * One marketplace served in more than one mode, picked per connection
 * (docs/features/marketplaces.md): Depop runs assisted, through browser automation once the
 * seller links a session, and through the API once Listora's partner access is granted and the
 * seller connects it; eBay runs through its API, or through browser automation until its API
 * is connected; Poshmark and Mercari run assisted or automated. Every mode reads and
 * writes the same `marketplace_listing` rows, so a switch is a change to the connection and
 * needs no data migration; each attempt builds its payload under the connection it runs with.
 *
 * An automation connection that waits to be relinked (the marketplace rejected its session, or
 * showed a check automation must not pass) holds no session, so it is served assisted until
 * the seller logs in again: the user does the step, which is always honest.
 */
import type { ConnectionStatus, Marketplace } from '@listora/db';
import { assertNever } from '@listora/shared';

import type {
  AdapterContext,
  ConnectionRef,
  Health,
  LabelReadRequest,
  ListingPayload,
  ListingRef,
  MarketplaceAdapter,
  MarketplaceCapabilities,
  OperationRequest,
  OrderFeesResult,
  Outcome,
  RemoteListingState,
  RemoteListings,
  RemoteOrder,
  RemoteOrderLabel,
  ValidationIssue,
} from './adapter.ts';
import type { ItemSnapshot, ListingVariant } from './content.ts';

export interface ConnectionAwareAdapterOptions {
  /**
   * Serves listings under an assisted connection, and every step automation has to give to the
   * user; also those without a connection unless `unconnected` is set.
   */
  assisted: MarketplaceAdapter;
  /**
   * Serves listings without a connection, when that is not the assisted adapter (eBay with its
   * API adapter configured: an unconnected listing is asked to connect eBay).
   */
  unconnected?: MarketplaceAdapter;
  /**
   * Serves listings under an `api` connection. Without it (no API adapter configured yet), those
   * listings are served assisted too: the user does the step, which is always honest.
   */
  api?: MarketplaceAdapter;
  /**
   * Serves listings under a working `automation` connection (the browser runner). Without it,
   * and while the connection waits to be relinked, they are served assisted.
   */
  automation?: MarketplaceAdapter;
}

/** Automation connection states that still hold a session the runner may use. */
const USABLE_SESSION_STATUSES: readonly ConnectionStatus[] = ['connected', 'degraded'];

export class ConnectionAwareAdapter implements MarketplaceAdapter {
  readonly id: Marketplace;
  readonly #assisted: MarketplaceAdapter;
  readonly #unconnected: MarketplaceAdapter;
  readonly #api: MarketplaceAdapter | undefined;
  readonly #automation: MarketplaceAdapter | undefined;

  constructor(options: ConnectionAwareAdapterOptions) {
    const { assisted, unconnected, api, automation } = options;
    for (const [mode, adapter] of [
      ['unconnected', unconnected],
      ['api', api],
      ['automation', automation],
    ] as const) {
      if (adapter !== undefined && adapter.id !== assisted.id) {
        throw new Error(
          `${mode} adapter is for ${adapter.id}, assisted adapter for ${assisted.id}`,
        );
      }
    }
    this.id = assisted.id;
    this.#assisted = assisted;
    this.#unconnected = unconnected ?? assisted;
    this.#api = api;
    this.#automation = automation;
  }

  /** The adapter that serves a connection. */
  adapterFor(connection: ConnectionRef | null | undefined): MarketplaceAdapter {
    if (connection === null || connection === undefined) return this.#unconnected;
    switch (connection.mode) {
      case 'api':
        return this.#api ?? this.#assisted;
      case 'automation':
        return this.#automation !== undefined && USABLE_SESSION_STATUSES.includes(connection.status)
          ? this.#automation
          : this.#assisted;
      case 'assisted':
        return this.#assisted;
      default:
        return assertNever(connection.mode, 'connection mode');
    }
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

  newListingId(
    item: ItemSnapshot,
    usedIds: readonly string[],
    connection: ConnectionRef | null,
  ): string | null {
    return this.adapterFor(connection).newListingId?.(item, usedIds, connection) ?? null;
  }

  /** The serving adapter's orders; throws when it can't read them (an assisted one never can). */
  listOrdersSince(since: Date | null, ctx: AdapterContext): Promise<RemoteOrder[]> {
    const adapter = this.adapterFor(ctx.connection);
    if (adapter.listOrdersSince === undefined) {
      return Promise.reject(
        new Error(`the ${adapter.id} adapter for this connection reads no orders`),
      );
    }
    return adapter.listOrdersSince(since, ctx);
  }

  /** The serving adapter's listings; throws when it can't read them (an assisted one never can). */
  listListings(ctx: AdapterContext): Promise<RemoteListings> {
    const adapter = this.adapterFor(ctx.connection);
    if (adapter.listListings === undefined) {
      return Promise.reject(
        new Error(`the ${adapter.id} adapter for this connection reads no listings`),
      );
    }
    return adapter.listListings(ctx);
  }

  /** The serving adapter's order labels; throws when it can't read them (an assisted one never can). */
  readOrderLabels(
    orders: readonly LabelReadRequest[],
    ctx: AdapterContext,
  ): Promise<RemoteOrderLabel[]> {
    const adapter = this.adapterFor(ctx.connection);
    if (adapter.readOrderLabels === undefined) {
      return Promise.reject(
        new Error(`the ${adapter.id} adapter for this connection reads no order labels`),
      );
    }
    return adapter.readOrderLabels(orders, ctx);
  }

  /** The serving adapter's order fees; `unavailable` when it reports none (assisted). */
  async readOrderFees(externalOrderId: string, ctx: AdapterContext): Promise<OrderFeesResult> {
    const adapter = this.adapterFor(ctx.connection);
    if (adapter.readOrderFees === undefined) {
      return {
        type: 'unavailable',
        code: 'not_reported',
        message: 'This marketplace does not report order fees to Listora.',
      };
    }
    return adapter.readOrderFees(externalOrderId, ctx);
  }
}

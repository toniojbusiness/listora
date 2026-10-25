import type {
  Connection,
  ConnectionAuthorization,
  MarketplaceCapabilities as ContractCapabilities,
} from '@listora/api-contract';
import {
  authorizationState,
  describeConnection,
  type AuthorizationFailureCode,
  type AuthorizationRow,
  type ConnectionRow,
} from '@listora/connections';
import type { Marketplace } from '@listora/db';
import type { AdapterRegistry, MarketplaceCapabilities } from '@listora/marketplaces';

/** The URL scheme `ASWebAuthenticationSession` waits for; the callback redirects to it. */
export const APP_CALLBACK_SCHEME = 'listora';

export interface ConnectionViewContext {
  adapters: AdapterRegistry;
  /** Whether this process can connect the marketplace (an OAuth client and a token vault). */
  canConnect: (marketplace: Marketplace) => boolean;
  now: Date;
}

/** A marketplace with no adapter in this process offers nothing. */
const NO_CAPABILITIES: Omit<ContractCapabilities, 'connect'> = {
  create: 'none',
  updatePrice: 'none',
  updateDetails: 'none',
  delist: 'none',
  relist: 'none',
  markSold: 'none',
  verifyRead: 'api',
  importListings: 'none',
  saleDetection: [],
  imageTransport: 'url_fetch',
};

export function connectionView(
  marketplace: Marketplace,
  row: ConnectionRow | undefined,
  context: ConnectionViewContext,
): Connection {
  const canConnect = context.canConnect(marketplace);
  const capabilities = context.adapters.capabilities(
    marketplace,
    row === undefined ? null : { id: row.id, mode: row.mode },
  );
  const view = describeConnection({
    marketplace,
    row,
    defaultMode: defaultMode(capabilities, canConnect),
    canConnect,
    now: context.now,
  });
  return {
    marketplace: view.marketplace,
    mode: view.mode,
    status: view.status,
    statusDisplay: view.statusDisplay,
    capabilities: contractCapabilities(capabilities, canConnect),
    availableActions: view.actions,
    ...(view.displayName === undefined ? {} : { displayName: view.displayName }),
    ...(view.connectedAt === undefined ? {} : { connectedAt: view.connectedAt.toISOString() }),
    ...(view.grantExpiresAt === undefined
      ? {}
      : { grantExpiresAt: view.grantExpiresAt.toISOString() }),
    ...(view.lastOkAt === undefined ? {} : { lastOkAt: view.lastOkAt.toISOString() }),
    ...(view.lastIssue === undefined
      ? {}
      : {
          lastIssue: {
            code: view.lastIssue.code,
            message: view.lastIssue.message,
            occurredAt: view.lastIssue.occurredAt.toISOString(),
          },
        }),
  };
}

export function authorizationView(
  row: AuthorizationRow,
  extras: {
    now: Date;
    requestId: string;
    /** Only in the response that starts the attempt. */
    authorizationUrl?: string;
    /** The connection a completed attempt connected. */
    connection?: Connection;
  },
): ConnectionAuthorization {
  return {
    id: row.id,
    marketplace: row.marketplace,
    status: authorizationState(row, extras.now),
    ...(extras.authorizationUrl === undefined ? {} : { authorizationUrl: extras.authorizationUrl }),
    callbackUrlScheme: APP_CALLBACK_SCHEME,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at.toISOString() }),
    ...(row.status === 'failed' && row.failure_code !== null && row.failure_message !== null
      ? {
          failure: {
            code: failureCode(row.failure_code),
            message: row.failure_message,
            // Connecting again starts a new attempt, which may succeed.
            retryable: true,
            requestId: extras.requestId,
          },
        }
      : {}),
    ...(row.status === 'completed' && extras.connection !== undefined
      ? { connection: extras.connection }
      : {}),
  };
}

/** The stored failure code; only the two authorization codes are ever written. */
function failureCode(code: string): AuthorizationFailureCode {
  return code === 'marketplace_authorization_denied'
    ? 'marketplace_authorization_denied'
    : 'marketplace_authorization_failed';
}

/** How the marketplace works when the account has no connection. */
function defaultMode(
  capabilities: MarketplaceCapabilities | undefined,
  canConnect: boolean,
): 'api' | 'assisted' {
  if (canConnect || capabilities === undefined) return 'api';
  return capabilities.connect === 'oauth' || capabilities.verifyRead === 'api' ? 'api' : 'assisted';
}

/**
 * The adapter's flags in contract terms. `connect` says whether connecting is possible here and
 * now, which an adapter cannot know: it needs this process's OAuth client and token vault.
 */
function contractCapabilities(
  capabilities: MarketplaceCapabilities | undefined,
  canConnect: boolean,
): ContractCapabilities {
  const connect = canConnect ? 'oauth' : 'none';
  if (capabilities === undefined) return { connect, ...NO_CAPABILITIES };
  return {
    connect,
    create: capabilities.create,
    updatePrice: capabilities.updatePrice,
    updateDetails: capabilities.updateDetails,
    delist: capabilities.delist,
    relist: capabilities.relist,
    markSold: capabilities.markSold,
    verifyRead: capabilities.verifyRead,
    importListings: capabilities.importListings,
    saleDetection: [...capabilities.saleDetection],
    imageTransport: capabilities.imageTransport,
  };
}

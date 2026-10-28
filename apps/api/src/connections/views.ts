import type {
  Connection,
  ConnectionAuthorization,
  ConnectionHealthSummary,
  MarketplaceCapabilities as ContractCapabilities,
} from '@listora/api-contract';
import {
  authorizationState,
  describeConnection,
  describeExecution,
  phoneSessionState,
  summarizeConnectionHealth,
  type AuthorizationFailureCode,
  type AuthorizationRow,
  type CloudAccess,
  type ConnectionRow,
  type ConnectionView,
  type ExecutionState,
  type ExecutionView,
  type SessionCheckState,
} from '@listora/connections';
import { MARKETPLACES, type Marketplace, type SaleCheckHealth } from '@listora/db';
import type { AdapterRegistry, MarketplaceCapabilities } from '@listora/marketplaces';

/** The URL scheme `ASWebAuthenticationSession` waits for; the callback redirects to it. */
export const APP_CALLBACK_SCHEME = 'listora';

/** An automation connection's sale checks, from its schedule. */
export interface SaleCheckState {
  health: SaleCheckHealth;
  lastCheckedAt: Date | null;
  lastSucceededAt: Date | null;
  nextCheckAt: Date;
  lastError: { code: string; message: string } | null;
}

export interface ConnectionViewContext {
  adapters: AdapterRegistry;
  /** Whether this process can connect the marketplace (an OAuth client and a token vault). */
  canConnect: (marketplace: Marketplace) => boolean;
  /** The account's session checks by connection id: how automation connections are shown. */
  sessionChecks: ReadonlyMap<string, SessionCheckState>;
  /** The account's sale checks by connection id: whether each sees the seller's sales. */
  saleChecks: ReadonlyMap<string, SaleCheckState>;
  /** The account's devices and what waits for its phones: where automated steps run. */
  execution: ExecutionState;
  /** Whether each marketplace may run in Listora's cloud (`cloudAccess`). */
  cloudAccess: (marketplace: Marketplace) => CloudAccess;
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
  return contractConnection(describe(marketplace, row, context), row, context);
}

/** `getConnectionHealth`: every marketplace in display order, and what needs attention. */
export function connectionHealthView(
  rows: ReadonlyMap<Marketplace, ConnectionRow>,
  context: ConnectionViewContext,
): ConnectionHealthSummary {
  const views = MARKETPLACES.map((marketplace) =>
    describe(marketplace, rows.get(marketplace), context),
  );
  const summary = summarizeConnectionHealth(views);
  return {
    needsAttention: summary.needsAttention,
    ...(summary.banner === undefined ? {} : { banner: summary.banner }),
    attention: summary.attention,
    connections: views.map((view) => contractConnection(view, rows.get(view.marketplace), context)),
    saleForwarding: summary.saleForwarding,
    ...(summary.lastCheckedAt === undefined
      ? {}
      : { lastCheckedAt: summary.lastCheckedAt.toISOString() }),
  };
}

function describe(
  marketplace: Marketplace,
  row: ConnectionRow | undefined,
  context: ConnectionViewContext,
): ConnectionView {
  const canConnect = context.canConnect(marketplace);
  const phone = row === undefined ? undefined : phoneSessionState(row, context.execution);
  return describeConnection({
    marketplace,
    row,
    defaultMode: defaultMode(capabilitiesOf(marketplace, row, context), canConnect),
    canConnect,
    sessionCheck: row === undefined ? null : (context.sessionChecks.get(row.id) ?? null),
    ...(phone === undefined ? {} : { phone }),
    now: context.now,
  });
}

function capabilitiesOf(
  marketplace: Marketplace,
  row: ConnectionRow | undefined,
  context: ConnectionViewContext,
): MarketplaceCapabilities | undefined {
  return context.adapters.capabilities(
    marketplace,
    row === undefined ? null : { id: row.id, mode: row.mode, status: row.status },
  );
}

function contractConnection(
  view: ConnectionView,
  row: ConnectionRow | undefined,
  context: ConnectionViewContext,
): Connection {
  const { marketplace } = view;
  const canConnect = context.canConnect(marketplace);
  const capabilities = capabilitiesOf(marketplace, row, context);
  const execution =
    row === undefined
      ? undefined
      : describeExecution(row, context.execution, context.cloudAccess(marketplace));
  const saleChecks = row?.mode === 'automation' ? context.saleChecks.get(row.id) : undefined;
  return {
    marketplace: view.marketplace,
    mode: view.mode,
    status: view.status,
    statusDisplay: view.statusDisplay,
    capabilities: contractCapabilities(capabilities, canConnect),
    availableActions: view.actions,
    readOnly: row?.read_only ?? false,
    ...(view.displayName === undefined ? {} : { displayName: view.displayName }),
    ...(view.connectedAt === undefined ? {} : { connectedAt: view.connectedAt.toISOString() }),
    ...(view.grantExpiresAt === undefined
      ? {}
      : { grantExpiresAt: view.grantExpiresAt.toISOString() }),
    ...(view.lastOkAt === undefined ? {} : { lastOkAt: view.lastOkAt.toISOString() }),
    ...(view.lastCheckedAt === undefined
      ? {}
      : { lastCheckedAt: view.lastCheckedAt.toISOString() }),
    ...(view.lastIssue === undefined
      ? {}
      : {
          lastIssue: {
            code: view.lastIssue.code,
            message: view.lastIssue.message,
            occurredAt: view.lastIssue.occurredAt.toISOString(),
          },
        }),
    ...(execution === undefined ? {} : { execution: executionView(execution) }),
    ...(saleChecks === undefined ? {} : { saleChecks: saleChecksView(saleChecks) }),
  };
}

/** The contract's `ConnectionSaleChecks`. */
function saleChecksView(state: SaleCheckState): NonNullable<Connection['saleChecks']> {
  return {
    health: state.health,
    ...(state.lastCheckedAt === null ? {} : { lastCheckedAt: state.lastCheckedAt.toISOString() }),
    ...(state.lastSucceededAt === null
      ? {}
      : { lastSucceededAt: state.lastSucceededAt.toISOString() }),
    nextCheckAt: state.nextCheckAt.toISOString(),
    ...(state.lastError === null ? {} : { lastError: state.lastError }),
  };
}

/** The contract's `ConnectionExecution`, which Link accounts shows the same way. */
export function executionView(execution: ExecutionView): NonNullable<Connection['execution']> {
  return {
    location: execution.location,
    label: execution.label,
    ...(execution.device === undefined
      ? {}
      : {
          deviceInstallationId: execution.device.installationId,
          deviceName: execution.device.name,
        }),
    ...(execution.waiting === undefined
      ? {}
      : {
          waiting: execution.waiting.count,
          waitingSince: execution.waiting.since.toISOString(),
        }),
    cloudAllowed: execution.cloud.allowed,
    ...(execution.cloud.allowed ? {} : { cloudBlockedReason: execution.cloud.reason }),
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

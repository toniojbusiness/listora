/**
 * Linking a marketplace by signing in (decision D1; docs/features/marketplace-linking.md). The
 * user signs into the marketplace's own sign-in page in the app, and the app hands over that
 * site's cookies, never the password. `linkMarketplaceSession` stores them encrypted on the
 * account's automation connection (`linkAutomationSession`, which also asks the browser runner
 * to check them), and the app polls `getMarketplaceSession` until the check decided. Cookie
 * values are never logged or returned: only the session vault's ciphertext keeps them.
 */
import type { SessionCookie as ContractSessionCookie } from '@listora/api-contract';
import {
  AUTOMATED_MARKETPLACES,
  cloudAccess,
  isAutomatedMarketplace,
  linkAutomationSession,
  type AutomatedMarketplace,
  type AutomationProfile,
} from '@listora/automation';
import {
  accountExecutionState,
  ConnectionModeConflictError,
  describeExecution,
  phoneSessionState,
  SessionCookieError,
  type SessionCookie,
  type SessionVault,
} from '@listora/connections';
import type { DbExecutor, Marketplace } from '@listora/db';
import { assertNever } from '@listora/shared';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { ApiError, notFound, validationFailed } from '../errors.ts';
import { marketplaceName } from '../listings/views.ts';
import { findDevice } from '../phone/devices.ts';
import type { Tenant } from '../tenancy.ts';
import { marketplaceSessionView, type SessionRow } from './views.ts';

export interface MarketplaceSessionsDependencies {
  /**
   * Stores sessions; the API only ever encrypts them (only the browser runner decrypts).
   * Undefined without a token vault; then nothing can be linked.
   */
  vault: SessionVault | undefined;
  /** Each automated marketplace's configured profile: its sign-in page and cookie domains. */
  profiles: Readonly<Record<AutomatedMarketplace, AutomationProfile>>;
}

export interface MarketplaceSessionRouteDependencies
  extends RouteDependencies, MarketplaceSessionsDependencies {
  now: () => Date;
}

export function registerMarketplaceSessionRoutes(
  app: FastifyInstance,
  deps: MarketplaceSessionRouteDependencies,
): void {
  contractRoute(app, deps, 'listMarketplaceSessions', async ({ tenant, db }) => {
    const rows = await sessionRows(db, tenant, deps.profiles, AUTOMATED_MARKETPLACES);
    const now = deps.now();
    return {
      status: 200,
      body: {
        data: AUTOMATED_MARKETPLACES.map((marketplace) =>
          marketplaceSessionView(rowFor(rows, marketplace), deps.profiles[marketplace], now),
        ),
      },
    };
  });

  contractRoute(app, deps, 'getMarketplaceSession', async ({ tenant, db, params }) => {
    const marketplace = sessionMarketplace(params.marketplace);
    const rows = await sessionRows(db, tenant, deps.profiles, [marketplace]);
    return {
      status: 200,
      body: marketplaceSessionView(
        rowFor(rows, marketplace),
        deps.profiles[marketplace],
        deps.now(),
      ),
    };
  });

  contractRoute(app, deps, 'linkMarketplaceSession', async ({ tenant, db, params, body }) => {
    const marketplace = sessionMarketplace(params.marketplace);
    const profile = deps.profiles[marketplace];
    const name = marketplaceName(marketplace);
    if (deps.vault === undefined) {
      throw new ApiError(
        'marketplace_action_unavailable',
        `Listora can't link ${name} accounts yet.`,
      );
    }
    // The device that links it runs its automated steps when they run on the phone.
    let deviceId: string | null = null;
    if (body.installationId !== undefined) {
      const device = await findDevice(db, tenant, body.installationId);
      if (device === undefined) {
        throw validationFailed(
          [{ field: 'installationId', message: 'This device is not registered.' }],
          'Listora does not know this iPhone yet. Try again in a moment.',
        );
      }
      deviceId = device.id;
    }
    try {
      await linkAutomationSession(
        db,
        { vault: deps.vault, profile },
        {
          accountId: tenant.accountId,
          marketplace,
          cookies: body.cookies.map(sessionCookie),
          ...(body.displayName === undefined ? {} : { displayName: body.displayName.trim() }),
          deviceId,
        },
      );
    } catch (error) {
      if (error instanceof SessionCookieError) {
        // The vault's messages describe the problem, never a cookie's name or value.
        throw validationFailed(
          [{ field: 'cookies', message: error.message }],
          `Listora couldn't use this ${name} sign-in. Sign in again.`,
        );
      }
      if (error instanceof ConnectionModeConflictError) {
        throw new ApiError(
          'marketplace_action_unavailable',
          `${name} is connected through its API, so there is nothing to sign in to.`,
          { cause: error },
        );
      }
      throw error;
    }
    const rows = await sessionRows(db, tenant, deps.profiles, [marketplace]);
    return {
      status: 201,
      body: marketplaceSessionView(rowFor(rows, marketplace), profile, deps.now()),
    };
  });
}

/**
 * The marketplace if it is linked by signing in; `404` otherwise. Every marketplace is today:
 * eBay and Depop until their APIs are connected (an API connection answers `409`).
 */
function sessionMarketplace(marketplace: Marketplace): AutomatedMarketplace {
  if (!isAutomatedMarketplace(marketplace)) throw notFound('Marketplace session');
  return marketplace;
}

function sessionCookie(cookie: ContractSessionCookie): SessionCookie {
  return { ...cookie, sameSite: sameSite(cookie.sameSite) };
}

function sameSite(value: ContractSessionCookie['sameSite']): SessionCookie['sameSite'] {
  switch (value) {
    case 'strict':
      return 'Strict';
    case 'lax':
      return 'Lax';
    case 'none':
      return 'None';
    default:
      return assertNever(value, 'sameSite');
  }
}

function rowFor(rows: readonly SessionRow[], marketplace: Marketplace): SessionRow {
  return (
    rows.find((row) => row.marketplace === marketplace) ?? {
      marketplace,
      connection: null,
      check: null,
    }
  );
}

/** The account's connections on the marketplaces, with each one's session check. */
async function sessionRows(
  db: DbExecutor,
  tenant: Tenant,
  profiles: Readonly<Record<AutomatedMarketplace, AutomationProfile>>,
  marketplaces: readonly Marketplace[],
): Promise<SessionRow[]> {
  const execution = await accountExecutionState(db, tenant.accountId);
  const rows = await db
    .selectFrom('marketplace_connection as connection')
    .leftJoin('session_check as check', (join) =>
      join
        .onRef('check.account_id', '=', 'connection.account_id')
        .onRef('check.connection_id', '=', 'connection.id'),
    )
    .select([
      'connection.id',
      'connection.marketplace',
      'connection.mode',
      'connection.runs_on',
      'connection.phone_device_id',
      'connection.status',
      'connection.display_name',
      'connection.last_error',
      'connection.last_error_code',
      'connection.last_error_at',
      'connection.granted_at',
      'connection.updated_at',
      'check.status as check_status',
      'check.attempts',
      'check.failure_code',
      'check.failure_message',
      'check.requested_at',
      'check.finished_at',
    ])
    .where('connection.account_id', '=', tenant.accountId)
    .where('connection.marketplace', 'in', marketplaces)
    .execute();
  return rows.map((row) => ({
    marketplace: row.marketplace,
    connection: {
      mode: row.mode,
      status: row.status,
      execution: describeExecution(row, execution, cloudAccess(profiles, row.marketplace)),
      phone: phoneSessionState(row, execution),
      displayName: row.display_name,
      lastError: row.last_error,
      lastErrorCode: row.last_error_code,
      lastErrorAt: row.last_error_at,
      linkedAt: row.granted_at,
      updatedAt: row.updated_at,
    },
    check:
      row.check_status === null || row.requested_at === null
        ? null
        : {
            status: row.check_status,
            attempts: row.attempts ?? 0,
            failureCode: row.failure_code,
            failureMessage: row.failure_message,
            requestedAt: row.requested_at,
            finishedAt: row.finished_at,
          },
  }));
}

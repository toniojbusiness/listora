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
  isAutomatedMarketplace,
  linkAutomationSession,
  type AutomatedMarketplace,
  type AutomationProfile,
} from '@listora/automation';
import type { DbExecutor, Marketplace } from '@listora/db';
import { assertNever } from '@listora/shared';
import {
  ConnectionModeConflictError,
  SessionCookieError,
  type SessionCookie,
  type SessionVault,
} from '@listora/vault';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { ApiError, notFound, validationFailed } from '../errors.ts';
import { marketplaceName } from '../listings/views.ts';
import type { Tenant } from '../tenancy.ts';
import { marketplaceSessionView, type SessionRow } from './views.ts';

export interface MarketplaceSessionDependencies extends RouteDependencies {
  /** Stores sessions; the API only ever encrypts them (only the browser runner decrypts). */
  vault: SessionVault;
  /** Each automated marketplace's configured profile: its sign-in page and cookie domains. */
  profiles: Readonly<Record<AutomatedMarketplace, AutomationProfile>>;
}

export function registerMarketplaceSessionRoutes(
  app: FastifyInstance,
  deps: MarketplaceSessionDependencies,
): void {
  contractRoute(app, deps, 'listMarketplaceSessions', async ({ tenant, db }) => {
    const rows = await sessionRows(db, tenant, AUTOMATED_MARKETPLACES);
    return {
      status: 200,
      body: {
        data: AUTOMATED_MARKETPLACES.map((marketplace) =>
          marketplaceSessionView(rowFor(rows, marketplace), deps.profiles[marketplace]),
        ),
      },
    };
  });

  contractRoute(app, deps, 'getMarketplaceSession', async ({ tenant, db, params }) => {
    const marketplace = sessionMarketplace(params.marketplace);
    const rows = await sessionRows(db, tenant, [marketplace]);
    return {
      status: 200,
      body: marketplaceSessionView(rowFor(rows, marketplace), deps.profiles[marketplace]),
    };
  });

  contractRoute(app, deps, 'linkMarketplaceSession', async ({ tenant, db, params, body }) => {
    const marketplace = sessionMarketplace(params.marketplace);
    const profile = deps.profiles[marketplace];
    const name = marketplaceName(marketplace);
    try {
      await linkAutomationSession(
        db,
        { vault: deps.vault, profile },
        {
          accountId: tenant.accountId,
          marketplace,
          cookies: body.cookies.map(sessionCookie),
          ...(body.displayName === undefined ? {} : { displayName: body.displayName.trim() }),
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
    const rows = await sessionRows(db, tenant, [marketplace]);
    return { status: 201, body: marketplaceSessionView(rowFor(rows, marketplace), profile) };
  });
}

/** The marketplace if it is linked by signing in; `404` otherwise (eBay connects by OAuth). */
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
  marketplaces: readonly Marketplace[],
): Promise<SessionRow[]> {
  const rows = await db
    .selectFrom('marketplace_connection as connection')
    .leftJoin('session_check as check', (join) =>
      join
        .onRef('check.account_id', '=', 'connection.account_id')
        .onRef('check.connection_id', '=', 'connection.id'),
    )
    .select([
      'connection.marketplace',
      'connection.mode',
      'connection.status',
      'connection.display_name',
      'connection.last_error',
      'connection.updated_at',
      'check.status as check_status',
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
      displayName: row.display_name,
      lastError: row.last_error,
      updatedAt: row.updated_at,
    },
    check:
      row.check_status === null || row.requested_at === null
        ? null
        : {
            status: row.check_status,
            failureCode: row.failure_code,
            failureMessage: row.failure_message,
            requestedAt: row.requested_at,
            finishedAt: row.finished_at,
          },
  }));
}

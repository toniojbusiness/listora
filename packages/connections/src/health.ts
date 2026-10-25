/**
 * The daily connection health check (`connection_health`, run by the worker's cron). For every
 * API connection that still holds its grant (`connected` or `degraded`) it makes one cheap call:
 * the access token (refreshed first when it is about to expire) asks the marketplace who it
 * belongs to (`MarketplaceOAuthClient.identify`, eBay's `getUser`). The answer sets the status:
 *
 * - it works → `connected`, with `last_ok_at` moved and the seller's current name;
 * - the marketplace refuses the grant (the refresh token is revoked or expired, or the token
 *   now belongs to another seller) → `reauth_required`;
 * - the marketplace cannot be asked now → `degraded`, with the problem, until a later check
 *   succeeds.
 *
 * A connection that needs the seller (`reauth_required`, `revoked`) is not checked: only
 * connecting again can change it. The expiry warning needs no call: it comes from
 * `refresh_expires_at` (`describeConnection`).
 */
import type { Db } from '@listora/db';
import { MARKETPLACE_NAMES, type OAuthClients } from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import type { ConnectionTokens } from './credentials.ts';
import { recordHealth, type HealthUpdate } from './store.ts';

export const CONNECTION_HEALTH_TASK = 'connection_health';
/** 05:41 UTC every day; Graphile Worker's cron runs it once across all workers. */
export const CONNECTION_HEALTH_SCHEDULE = '41 5 * * *';

/** Connections checked at the same time. */
const CONCURRENCY = 4;
const CHECK_DEADLINE_MS = 30_000;

export interface ConnectionHealthDependencies {
  db: Db;
  tokens: ConnectionTokens;
  oauth: OAuthClients;
  logger: Logger;
  now?: () => Date;
}

export interface HealthCheckSummary {
  checked: number;
  connected: number;
  degraded: number;
  reauthRequired: number;
}

/** Checks every connection that still holds its grant. Never throws for a marketplace answer. */
export async function runConnectionHealthChecks(
  deps: ConnectionHealthDependencies,
  signal?: AbortSignal,
): Promise<HealthCheckSummary> {
  const marketplaces = Object.keys(deps.oauth) as (keyof OAuthClients)[];
  const summary: HealthCheckSummary = { checked: 0, connected: 0, degraded: 0, reauthRequired: 0 };
  if (marketplaces.length === 0) return summary;
  const rows = await deps.db
    .selectFrom('marketplace_connection')
    .select('id')
    .where('mode', '=', 'api')
    .where('status', 'in', ['connected', 'degraded'])
    .where('token_ciphertext', 'is not', null)
    .where('marketplace', 'in', marketplaces)
    .orderBy('id')
    .execute();
  const queue = rows.map((row) => row.id);
  const worker = async (): Promise<void> => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (signal?.aborted === true) return;
      const status = await checkConnectionHealth(deps, id);
      summary.checked += 1;
      if (status === 'connected') summary.connected += 1;
      else if (status === 'degraded') summary.degraded += 1;
      else summary.reauthRequired += 1;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  deps.logger.info({ ...summary }, 'connection health checks finished');
  return summary;
}

/** Checks one connection and records the result; returns the status it recorded. */
export async function checkConnectionHealth(
  deps: ConnectionHealthDependencies,
  connectionId: string,
): Promise<HealthUpdate['status']> {
  const now = deps.now ?? (() => new Date());
  const row = await deps.db
    .selectFrom('marketplace_connection')
    .select(['id', 'marketplace', 'external_user_id'])
    .where('id', '=', connectionId)
    .executeTakeFirst();
  const oauth = row === undefined ? undefined : deps.oauth[row.marketplace];
  if (row === undefined || oauth === undefined) return 'degraded';
  const name = MARKETPLACE_NAMES[row.marketplace];
  const signal = AbortSignal.timeout(CHECK_DEADLINE_MS);

  let update: HealthUpdate | undefined;
  for (let attempt = 1; update === undefined; attempt += 1) {
    const token = await deps.tokens.accessToken(connectionId, signal);
    // The credentials already recorded a refused or failed refresh on the connection.
    if (token.type === 'reauth_required') return 'reauth_required';
    if (token.type === 'unavailable') return 'degraded';
    const identity = await oauth.identify(token.accessToken, { signal, now: now() });
    switch (identity.type) {
      case 'identified':
        update =
          row.external_user_id === null || identity.externalUserId === row.external_user_id
            ? { status: 'connected', displayName: identity.displayName }
            : {
                status: 'reauth_required',
                code: 'account_changed',
                message: `${name} now reports a different account for Listora's access. Reconnect ${name}.`,
              };
        break;
      case 'unauthorized':
        // An access token can stop working before its expiry: refresh once and ask again.
        if (attempt === 1) {
          await deps.tokens.invalidate(connectionId, token.accessToken);
          break;
        }
        update = {
          status: 'reauth_required',
          code: identity.code,
          message: `${name} no longer accepts Listora's access. Reconnect ${name}.`,
        };
        break;
      case 'unavailable':
        update = { status: 'degraded', code: identity.code, message: identity.message };
        break;
    }
  }
  await recordHealth(deps.db, connectionId, update, now());
  if (update.status !== 'connected') {
    deps.logger.warn(
      { connectionId, marketplace: row.marketplace, status: update.status, code: update.code },
      'connection health check found a problem',
    );
  }
  return update.status;
}

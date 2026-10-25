/**
 * Connecting a marketplace account (OAuth 2.0 authorization code grant), in two requests:
 *
 * 1. `startAuthorization` (the signed-in user): a random 256-bit `state`, stored only as its
 *    SHA-256 on a `connection_authorization` row that expires in ten minutes, and the
 *    marketplace's consent URL carrying it. The app opens that URL in
 *    `ASWebAuthenticationSession`.
 * 2. `completeAuthorization` (the marketplace's redirect, no bearer token): the `state` finds the
 *    attempt, and with it the account and user, and is used once. The code is exchanged on the
 *    server, the seller's immutable id is read from the marketplace, and the tokens are sealed
 *    in the token vault and stored on the account's connection for that marketplace, all before
 *    the attempt is marked `completed`. Every failure is recorded on the attempt with a reason
 *    the app shows; the app reads the attempt back and never trusts the redirect alone.
 *
 * An account has at most one connection per marketplace: connecting again (to reconnect after
 * a revocation, or before the grant expires) renews that connection's tokens. A different
 * seller account on the same marketplace is refused, because the account's listings belong to
 * the connected one.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { Selectable } from 'kysely';
import { sql } from 'kysely';

import {
  inTransaction,
  type ConnectionAuthorizationTable,
  type Db,
  type DbExecutor,
  type DbTransaction,
  type Marketplace,
} from '@listora/db';
import {
  MARKETPLACE_NAMES,
  type MarketplaceOAuthClient,
  type OAuthClients,
  type OAuthGrant,
} from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import type { ConnectionRow } from './store.ts';
import { TokenVaultError, type TokenSealer } from './vault.ts';

/** How long the user has to finish the marketplace's consent page. */
export const AUTHORIZATION_TTL_MS = 10 * 60_000;
/** Finished and expired attempts are deleted a day after they expire. */
const AUTHORIZATION_RETENTION_MS = 24 * 60 * 60_000;
/** Deadline for the code exchange and identity calls together. */
const CALLBACK_DEADLINE_MS = 30_000;

export type AuthorizationRow = Selectable<ConnectionAuthorizationTable>;

/** Why an attempt failed: contract error codes that appear only inside a failed attempt. */
export type AuthorizationFailureCode =
  'marketplace_authorization_denied' | 'marketplace_authorization_failed';

/** An attempt as the API shows it; `expired` is a pending attempt past its expiry. */
export type AuthorizationState = 'pending' | 'completed' | 'failed' | 'expired';

export function authorizationState(row: AuthorizationRow, now: Date): AuthorizationState {
  if (row.status === 'pending' && row.expires_at.getTime() <= now.getTime()) return 'expired';
  return row.status;
}

export interface StartedAuthorization {
  authorization: AuthorizationRow;
  /** The marketplace's consent page; it carries the state, so it is never stored. */
  authorizationUrl: string;
}

/**
 * Starts an attempt for `user` of `account`. The caller checks that the marketplace has an
 * OAuth client and the process a token vault, so the attempt can complete.
 */
export async function startAuthorization(
  db: DbExecutor,
  oauth: MarketplaceOAuthClient,
  input: { accountId: string; userId: string; now: Date },
): Promise<StartedAuthorization> {
  const state = randomBytes(32).toString('base64url');
  // Attempts older than a day after their expiry only take space.
  await db
    .deleteFrom('connection_authorization')
    .where('account_id', '=', input.accountId)
    .where('expires_at', '<', new Date(input.now.getTime() - AUTHORIZATION_RETENTION_MS))
    .execute();
  const authorization = await db
    .insertInto('connection_authorization')
    .values({
      account_id: input.accountId,
      user_id: input.userId,
      marketplace: oauth.marketplace,
      state_sha256: stateHash(state),
      expires_at: new Date(input.now.getTime() + AUTHORIZATION_TTL_MS),
      created_at: input.now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { authorization, authorizationUrl: oauth.authorizationUrl(state) };
}

/** An account's attempt; undefined when it has none with that id. */
export async function findAuthorization(
  db: DbExecutor,
  accountId: string,
  marketplace: Marketplace,
  id: string,
): Promise<AuthorizationRow | undefined> {
  return db
    .selectFrom('connection_authorization')
    .selectAll()
    .where('account_id', '=', accountId)
    .where('marketplace', '=', marketplace)
    .where('id', '=', id)
    .executeTakeFirst();
}

/** What the marketplace's redirect carried (OAuth 2.0 query parameters). */
export interface CallbackInput {
  marketplace: Marketplace;
  state: string | undefined;
  code: string | undefined;
  /** `access_denied` when the seller declined. */
  error: string | undefined;
}

type LogFunctions = Pick<Logger, 'info' | 'warn' | 'error'>;

/** A pino logger, or the API's request logger. */
export interface AuthorizationLogger extends LogFunctions {
  child(bindings: Record<string, unknown>): LogFunctions;
}

export interface CompleteAuthorizationDependencies {
  db: Db;
  oauth: OAuthClients;
  /** Undefined when the process has no token vault: nothing can be stored, so it fails. */
  sealer: TokenSealer | undefined;
  logger: AuthorizationLogger;
  now?: () => Date;
  /**
   * Work that starts with a new or renewed grant, in the transaction that stores it, so it
   * cannot be lost (the API adds eBay's notification subscriptions job).
   */
  onConnected?: (trx: DbTransaction, connection: ConnectionRow) => Promise<void>;
}

/**
 * Handles the marketplace's redirect. Returns the attempt it settled, or undefined when the
 * state names none (missing, unknown, or for another marketplace): such a request changes
 * nothing. Never throws for a marketplace's answer; only a database failure throws.
 */
export async function completeAuthorization(
  deps: CompleteAuthorizationDependencies,
  input: CallbackInput,
): Promise<AuthorizationRow | undefined> {
  const now = deps.now ?? (() => new Date());
  if (input.state === undefined || input.state === '') return undefined;
  const claimed = await inTransaction(deps.db, async (trx) => {
    const row = await trx
      .selectFrom('connection_authorization')
      .selectAll()
      .where('state_sha256', '=', stateHash(input.state ?? ''))
      .where('marketplace', '=', input.marketplace)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) return undefined;
    // The state is single-use: a repeated callback (a reload) only reads the result.
    if (row.callback_at !== null) return { row, claimed: false };
    const updated = await trx
      .updateTable('connection_authorization')
      .set({ callback_at: now() })
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { row: updated, claimed: true };
  });
  if (claimed === undefined) return undefined;
  const { row } = claimed;
  if (!claimed.claimed) return row;
  const name = MARKETPLACE_NAMES[input.marketplace];
  const log = deps.logger.child({
    authorizationId: row.id,
    accountId: row.account_id,
    marketplace: input.marketplace,
  });

  if (authorizationState(row, now()) === 'expired') {
    return fail(deps.db, row, 'marketplace_authorization_failed', {
      message: `The ${name} sign-in took too long. Connect ${name} again.`,
      reason: 'expired',
      log,
      now: now(),
    });
  }
  if (input.error !== undefined && input.error !== '') {
    const denied = input.error === 'access_denied';
    return fail(
      deps.db,
      row,
      denied ? 'marketplace_authorization_denied' : 'marketplace_authorization_failed',
      {
        message: denied
          ? `You didn't allow Listora to use your ${name} account, so nothing changed.`
          : `${name} didn't finish the sign-in. Connect ${name} again.`,
        reason: denied ? 'denied' : 'marketplace_error',
        log,
        now: now(),
      },
    );
  }
  const oauth = deps.oauth[input.marketplace];
  if (input.code === undefined || input.code === '' || oauth === undefined) {
    return fail(deps.db, row, 'marketplace_authorization_failed', {
      message: `${name} didn't finish the sign-in. Connect ${name} again.`,
      reason: oauth === undefined ? 'no_oauth_client' : 'no_code',
      log,
      now: now(),
    });
  }
  if (deps.sealer === undefined) {
    return fail(deps.db, row, 'marketplace_authorization_failed', {
      message: `Listora can't store ${name} access right now. Try again later.`,
      reason: 'no_token_vault',
      log,
      now: now(),
    });
  }

  const signal = AbortSignal.timeout(CALLBACK_DEADLINE_MS);
  const exchanged = await oauth.exchangeCode(input.code, { signal, now: now() });
  if (exchanged.type !== 'granted') {
    return fail(deps.db, row, 'marketplace_authorization_failed', {
      message:
        exchanged.type === 'rejected'
          ? exchanged.message
          : `${name} couldn't be reached to finish connecting. Connect ${name} again.`,
      reason: exchanged.code,
      log,
      now: now(),
    });
  }
  const { grant } = exchanged;
  const identity = await oauth.identify(grant.tokens.accessToken, { signal, now: now() });
  if (identity.type !== 'identified') {
    return fail(deps.db, row, 'marketplace_authorization_failed', {
      message: `${name} couldn't confirm which account you signed in to. Connect ${name} again.`,
      reason: identity.code,
      log,
      now: now(),
    });
  }

  const sealer = deps.sealer;
  const stored = await inTransaction(deps.db, async (trx) => {
    // One writer per account: two attempts finishing at once still leave one connection.
    await sql`select id from account where id = ${row.account_id} for update`.execute(trx);
    const existing = await trx
      .selectFrom('marketplace_connection')
      .selectAll()
      .where('account_id', '=', row.account_id)
      .where('marketplace', '=', input.marketplace)
      .orderBy('created_at')
      .orderBy('id')
      .forUpdate()
      .executeTakeFirst();
    if (
      existing?.external_user_id !== undefined &&
      existing.external_user_id !== null &&
      existing.external_user_id !== identity.externalUserId
    ) {
      return { mismatch: existing } as const;
    }
    const connectionId = existing?.id ?? (await newId(trx));
    let tokenCiphertext: Buffer;
    try {
      tokenCiphertext = await sealer.seal(grant.tokens, {
        marketplace: input.marketplace,
        connectionId,
      });
    } catch (error) {
      if (!(error instanceof TokenVaultError)) throw error;
      return { vaultFailure: error } as const;
    }
    const values = connectionValues(grant, identity, tokenCiphertext, now());
    const connection =
      existing === undefined
        ? await trx
            .insertInto('marketplace_connection')
            .values({
              id: connectionId,
              account_id: row.account_id,
              marketplace: input.marketplace,
              ...values,
            })
            .returningAll()
            .executeTakeFirstOrThrow()
        : await trx
            .updateTable('marketplace_connection')
            .set(values)
            .where('id', '=', existing.id)
            .returningAll()
            .executeTakeFirstOrThrow();
    const completed = await trx
      .updateTable('connection_authorization')
      .set({ status: 'completed', connection_id: connection.id, completed_at: now() })
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await deps.onConnected?.(trx, connection);
    return { completed, connection } as const;
  });
  if ('vaultFailure' in stored || 'mismatch' in stored) {
    // The grant is not kept, so it must not stay active at the marketplace either.
    const revoked = await oauth.revoke(grant.tokens, { signal, now: now() });
    if (!revoked) log.warn('could not revoke a grant that was not kept');
  }
  if ('vaultFailure' in stored) {
    log.error({ err: stored.vaultFailure }, 'could not seal the tokens of a new grant');
    return fail(deps.db, row, 'marketplace_authorization_failed', {
      message: `Listora can't store ${name} access right now. Try again later.`,
      reason: 'token_vault_unavailable',
      log,
      now: now(),
    });
  }
  if ('mismatch' in stored) {
    const connected = stored.mismatch.display_name;
    return fail(deps.db, row, 'marketplace_authorization_failed', {
      message: `You signed in to a different ${name} account${
        identity.displayName === null ? '' : ` (${identity.displayName})`
      } than the one connected to Listora${connected === null ? '' : ` (${connected})`}. Sign in to that account to reconnect it.`,
      reason: 'different_account',
      log,
      now: now(),
    });
  }
  log.info(
    {
      connectionId: stored.connection.id,
      reconnected: stored.connection.created_at < row.created_at,
    },
    'marketplace account connected',
  );
  return stored.completed;
}

function connectionValues(
  grant: OAuthGrant,
  identity: { externalUserId: string; displayName: string | null },
  tokenCiphertext: Buffer,
  now: Date,
): Omit<
  Partial<ConnectionRow>,
  'id' | 'account_id' | 'marketplace' | 'created_at' | 'updated_at'
> & { mode: 'api' } {
  return {
    mode: 'api',
    external_user_id: identity.externalUserId,
    display_name: identity.displayName,
    token_ciphertext: tokenCiphertext,
    access_expires_at: grant.accessExpiresAt,
    refresh_expires_at: grant.refreshExpiresAt,
    scopes: grant.scopes,
    status: 'connected',
    granted_at: now,
    last_ok_at: now,
    last_error: null,
    last_error_code: null,
    last_error_at: null,
  };
}

async function fail(
  db: Db,
  row: AuthorizationRow,
  code: AuthorizationFailureCode,
  details: { message: string; reason: string; log: LogFunctions; now: Date },
): Promise<AuthorizationRow> {
  details.log.warn({ reason: details.reason }, 'marketplace connection attempt failed');
  return db
    .updateTable('connection_authorization')
    .set({
      status: 'failed',
      failure_code: code,
      failure_message: details.message,
      completed_at: details.now,
    })
    .where('id', '=', row.id)
    .where('status', '=', 'pending')
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function newId(db: DbExecutor): Promise<string> {
  const { rows } = await sql<{ id: string }>`select uuidv7() as id`.execute(db);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('uuidv7() returned no id');
  return id;
}

function stateHash(state: string): Buffer {
  return createHash('sha256').update(state).digest();
}

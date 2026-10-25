/**
 * Use-time access to a connection's OAuth tokens (the worker's side of the token vault); the eBay
 * adapter gets them through `ConnectionSeller`.
 *
 * - **Decrypted only when used.** `accessToken` opens the vault ciphertext when an adapter or the
 *   health check asks. The decrypted access token is kept in memory until it nears expiry (as
 *   eBay recommends), keyed by the ciphertext it came from, so a token another worker refreshed,
 *   or a revocation that deleted it, is noticed on the next call.
 * - **Refreshed before expiry.** A token with less than `refreshMarginMs` left (5 minutes by
 *   default) is refreshed first.
 * - **Single-flight per connection.** In one process, callers that need a refresh at the same
 *   time share one. Across workers, a refresh holds the connection's row lock (`for update`)
 *   from reading the tokens until the new ones are stored; a worker that waited for the lock
 *   finds the fresh token and does not refresh again. Rotating refresh tokens (Depop) therefore
 *   never race: a lost refresh-token write would disconnect the seller.
 * - **Honest status.** A refresh the marketplace refuses (`invalid_grant`) makes the connection
 *   `reauth_required` at once; one that fails for now makes it `degraded`. Either way the
 *   adapter gets a result it maps to an outcome, never a thrown error.
 *
 * Tokens never reach a log line, an error message, or an operation excerpt.
 */
import { createHash } from 'node:crypto';

import type { Db, DbExecutor } from '@listora/db';
import type { MarketplaceOAuthClient, OAuthClients, OAuthTokens } from '@listora/marketplaces';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import { recordHealth, type ConnectionRow } from './store.ts';
import { TokenVaultError, type TokenVault } from './vault.ts';

export const DEFAULT_REFRESH_MARGIN_MS = 5 * 60_000;

/** What asking for a connection's access token came to. */
export type AccessTokenResult =
  | { type: 'ok'; accessToken: string }
  /** The seller has to connect the account again (the grant was revoked or expired). */
  | { type: 'reauth_required'; code: string; message: string }
  /** The token could not be refreshed now (the marketplace or the vault is unavailable). */
  | { type: 'unavailable'; code: string; message: string; retryAfterMs?: number };
/** A refresh's own deadline; callers that give up earlier stop waiting, the refresh goes on. */
const REFRESH_DEADLINE_MS = 20_000;

export interface ConnectionTokensDependencies {
  db: Db;
  vault: TokenVault;
  oauth: OAuthClients;
  logger: Logger;
  now?: () => Date;
  refreshMarginMs?: number;
}

interface CachedToken {
  accessToken: string;
  /** SHA-256 of the ciphertext it was opened from. */
  ciphertextDigest: string;
}

type Loaded = Pick<
  ConnectionRow,
  | 'id'
  | 'marketplace'
  | 'mode'
  | 'status'
  | 'token_ciphertext'
  | 'access_expires_at'
  | 'refresh_expires_at'
  | 'last_error'
>;

const LOADED_COLUMNS = [
  'id',
  'marketplace',
  'mode',
  'status',
  'token_ciphertext',
  'access_expires_at',
  'refresh_expires_at',
  'last_error',
] as const;

export class ConnectionTokens {
  readonly #deps: ConnectionTokensDependencies;
  readonly #now: () => Date;
  readonly #margin: number;
  readonly #cache = new Map<string, CachedToken>();
  readonly #inflight = new Map<string, Promise<AccessTokenResult>>();

  constructor(deps: ConnectionTokensDependencies) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    this.#margin = deps.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
  }

  /** A current access token for the connection, refreshed first when it is about to expire. */
  async accessToken(connectionId: string, signal?: AbortSignal): Promise<AccessTokenResult> {
    let pending = this.#inflight.get(connectionId);
    if (pending === undefined) {
      pending = this.#accessToken(connectionId).finally(() => {
        this.#inflight.delete(connectionId);
      });
      this.#inflight.set(connectionId, pending);
    }
    return signal === undefined ? pending : abortable(pending, signal);
  }

  /** The marketplace refused `accessToken` before its expiry: refresh before the next use. */
  async invalidate(connectionId: string, accessToken: string): Promise<void> {
    const cached = this.#cache.get(connectionId);
    if (cached?.accessToken !== accessToken) return;
    this.#cache.delete(connectionId);
    const now = this.#now();
    // Only the token that failed: a newer one another worker stored stays valid.
    await this.#deps.db
      .updateTable('marketplace_connection')
      .set({ access_expires_at: now })
      .where('id', '=', connectionId)
      .where('access_expires_at', '>', now)
      .where((eb) =>
        eb(
          eb.fn<string>('encode', [eb.fn('sha256', ['token_ciphertext']), eb.val('hex')]),
          '=',
          cached.ciphertextDigest,
        ),
      )
      .execute();
  }

  async #accessToken(connectionId: string): Promise<AccessTokenResult> {
    const row = await this.#deps.db
      .selectFrom('marketplace_connection')
      .select(LOADED_COLUMNS)
      .where('id', '=', connectionId)
      .executeTakeFirst();
    if (row === undefined) return NOT_CONNECTED;
    const unusable = this.#unusable(row);
    if (unusable !== undefined) return unusable;
    if (this.#fresh(row)) return this.#open(this.#deps.db, row);
    return this.#refresh(connectionId);
  }

  /** Refreshes under the connection's row lock, unless another worker already did. */
  async #refresh(connectionId: string): Promise<AccessTokenResult> {
    const { db, logger } = this.#deps;
    return db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('marketplace_connection')
        .select(LOADED_COLUMNS)
        .where('id', '=', connectionId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return NOT_CONNECTED;
      const unusable = this.#unusable(row);
      if (unusable !== undefined) return unusable;
      if (this.#fresh(row)) return this.#open(trx, row);
      const oauth = this.#oauthFor(row);
      const tokens = await this.#tokensOf(trx, row);
      if ('type' in tokens) return tokens;
      const name = MARKETPLACE_NAMES[row.marketplace];
      const log = logger.child({ connectionId, marketplace: row.marketplace });
      const now = this.#now();
      const refreshed = await oauth.refresh(tokens.refreshToken, {
        signal: AbortSignal.timeout(REFRESH_DEADLINE_MS),
        now,
      });
      switch (refreshed.type) {
        case 'refreshed': {
          const next: OAuthTokens = {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
          };
          let ciphertext: Buffer;
          try {
            ciphertext = await this.#deps.vault.seal(next, {
              marketplace: row.marketplace,
              connectionId,
            });
          } catch (error) {
            // The new token is lost, but the refresh token still works: the next call refreshes.
            log.error({ err: error }, 'could not seal a refreshed access token');
            return unavailable(`Listora can't use its ${name} access right now. Try again soon.`);
          }
          await trx
            .updateTable('marketplace_connection')
            .set({
              token_ciphertext: ciphertext,
              access_expires_at: refreshed.accessExpiresAt,
              ...(refreshed.refreshExpiresAt === undefined
                ? {}
                : { refresh_expires_at: refreshed.refreshExpiresAt }),
            })
            .where('id', '=', connectionId)
            .execute();
          await recordHealth(trx, connectionId, { status: 'connected' }, now);
          this.#cache.set(connectionId, {
            accessToken: next.accessToken,
            ciphertextDigest: digest(ciphertext),
          });
          log.info('refreshed a marketplace access token');
          return { type: 'ok', accessToken: next.accessToken };
        }
        case 'reauth_required':
          await recordHealth(
            trx,
            connectionId,
            { status: 'reauth_required', code: refreshed.code, message: refreshed.message },
            now,
          );
          this.#cache.delete(connectionId);
          log.warn({ code: refreshed.code }, 'marketplace refused the refresh token');
          return { type: 'reauth_required', code: refreshed.code, message: refreshed.message };
        case 'unavailable':
          await recordHealth(
            trx,
            connectionId,
            { status: 'degraded', code: refreshed.code, message: refreshed.message },
            now,
          );
          log.warn({ code: refreshed.code }, 'could not refresh a marketplace access token');
          return {
            type: 'unavailable',
            code: refreshed.code,
            message: refreshed.message,
            ...(refreshed.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: refreshed.retryAfterMs }),
          };
      }
    });
  }

  /** Why the connection's tokens cannot be used at all, or undefined when they can. */
  #unusable(row: Loaded): AccessTokenResult | undefined {
    const name = MARKETPLACE_NAMES[row.marketplace];
    if (row.mode !== 'api') return NOT_CONNECTED;
    if (row.status === 'reauth_required' || row.status === 'revoked') {
      return {
        type: 'reauth_required',
        code: row.status === 'revoked' ? 'authorization_revoked' : 'reauth_required',
        message: row.last_error ?? `Reconnect ${name} to continue.`,
      };
    }
    if (row.token_ciphertext === null) return NOT_CONNECTED;
    if (row.refresh_expires_at !== null && row.refresh_expires_at <= this.#now()) {
      return {
        type: 'reauth_required',
        code: 'grant_expired',
        message: `Listora's ${name} access expired. Reconnect ${name}.`,
      };
    }
    if (this.#deps.oauth[row.marketplace] === undefined) {
      return unavailable(`Listora can't connect to ${name} yet.`);
    }
    return undefined;
  }

  #fresh(row: Loaded): boolean {
    return (
      row.access_expires_at !== null &&
      row.access_expires_at.getTime() - this.#margin > this.#now().getTime()
    );
  }

  /** The stored access token, from the cache when it came from the same ciphertext. */
  async #open(db: DbExecutor, row: Loaded): Promise<AccessTokenResult> {
    const ciphertext = row.token_ciphertext;
    if (ciphertext === null) return NOT_CONNECTED;
    const ciphertextDigest = digest(ciphertext);
    const cached = this.#cache.get(row.id);
    if (cached?.ciphertextDigest === ciphertextDigest) {
      return { type: 'ok', accessToken: cached.accessToken };
    }
    const tokens = await this.#tokensOf(db, row);
    if ('type' in tokens) return tokens;
    this.#cache.set(row.id, { accessToken: tokens.accessToken, ciphertextDigest });
    return { type: 'ok', accessToken: tokens.accessToken };
  }

  /**
   * The decrypted tokens, or the result to answer when the vault cannot open them. `db` is the
   * executor that holds the row's lock, if any, so recording the problem cannot wait on it.
   */
  async #tokensOf(db: DbExecutor, row: Loaded): Promise<OAuthTokens | AccessTokenResult> {
    const name = MARKETPLACE_NAMES[row.marketplace];
    if (row.token_ciphertext === null) return NOT_CONNECTED;
    try {
      return await this.#deps.vault.open(row.token_ciphertext, {
        marketplace: row.marketplace,
        connectionId: row.id,
      });
    } catch (error) {
      if (!(error instanceof TokenVaultError)) throw error;
      this.#deps.logger.error(
        { err: error, connectionId: row.id, marketplace: row.marketplace },
        "could not open a connection's tokens",
      );
      if (error.kind === 'unavailable') {
        return unavailable(`Listora can't use its ${name} access right now. Try again soon.`);
      }
      // The stored tokens are unreadable for good: only connecting again gives new ones.
      const message = `Listora can't read its saved ${name} access. Reconnect ${name}.`;
      await recordHealth(
        db,
        row.id,
        { status: 'reauth_required', code: 'tokens_unreadable', message },
        this.#now(),
      );
      return { type: 'reauth_required', code: 'tokens_unreadable', message };
    }
  }

  #oauthFor(row: Loaded): MarketplaceOAuthClient {
    const oauth = this.#deps.oauth[row.marketplace];
    if (oauth === undefined) throw new Error(`no OAuth client for ${row.marketplace}`);
    return oauth;
  }
}

const NOT_CONNECTED: AccessTokenResult = {
  type: 'reauth_required',
  code: 'not_connected',
  message: 'Connect the marketplace account to continue.',
};

function unavailable(message: string): AccessTokenResult {
  return { type: 'unavailable', code: 'credentials_unavailable', message };
}

function digest(ciphertext: Buffer): string {
  return createHash('sha256').update(ciphertext).digest('hex');
}

/** `pending`, or a rejection when `signal` aborts first (the shared work goes on). */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

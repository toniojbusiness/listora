/**
 * A Depop seller's tokens, kept safe through rotation (docs/features/operations.md, item 10).
 * Depop invalidates a refresh token, and the access token issued with it, the moment it hands out
 * new ones, so:
 *
 * - **Single-flight.** Concurrent calls for one connection share one refresh: ten callers whose
 *   token expired cause exactly one token request. The shared refresh belongs to no caller, so one
 *   caller's deadline or abort never fails the others; each caller stops waiting on its own
 *   signal.
 * - **A lost write never strands the connection.** New tokens are kept in memory before they are
 *   stored. When storing them fails, this process keeps using them, refreshes from the newest
 *   refresh token, and stores them on the next call; the store accepts them over a stale
 *   "reconnect" mark, since that mark came from the old token.
 * - **A lost answer can't be helped.** When Depop rotates the tokens but its answer never
 *   arrives (a timeout), the new refresh token is gone and the seller must connect again: the
 *   token request's own timeout is generous for that reason.
 * - **A refused token may only mean another process refreshed first.** Before calling the grant
 *   gone, the store is read again (a few times, briefly), and tokens another process stored are
 *   used instead.
 *
 * The token store is the persistence behind it: per connection, encrypted at rest. The token
 * vault (T-16) implements it in Postgres; `MemoryDepopTokenStore` serves development, the fake,
 * and tests.
 */
import type { Logger } from '@listora/shared';

import type { ConnectionRef } from '../adapter.ts';
import {
  DepopReauthRequiredError,
  DepopTokenUnavailableError,
  type DepopOAuthClient,
  type DepopTokens,
} from './oauth.ts';

export interface DepopTokenStore {
  /** The connection's tokens; `null` when it has none (never connected, or disconnected). */
  load(connectionId: string): Promise<DepopTokens | null>;
  /**
   * Stores `next`, the tokens a refresh of `usedRefreshToken` returned, and marks the connection
   * connected again, but only while the stored refresh token is still `usedRefreshToken`.
   * Resolves `false` when other tokens were stored meanwhile (the seller connected again).
   */
  replace(connectionId: string, usedRefreshToken: string, next: DepopTokens): Promise<boolean>;
  /**
   * Depop refused `refusedRefreshToken`: the seller must connect Depop again, unless other tokens
   * were stored meanwhile (then nothing changes).
   */
  markReauthRequired(connectionId: string, refusedRefreshToken: string): Promise<void>;
}

/** Connection status as the memory store keeps it. */
export type DepopTokenStatus = 'connected' | 'reauth_required';

/**
 * Tokens in memory, for development, the fake, and tests: lost when the process stops, so after
 * a restart the seller connects again (the refresh token in configuration has been used up).
 */
export class MemoryDepopTokenStore implements DepopTokenStore {
  readonly #rows = new Map<string, { tokens: DepopTokens; status: DepopTokenStatus }>();
  #failures = 0;

  /** Stores a connection's tokens, as connecting Depop does. */
  connect(connectionId: string, tokens: DepopTokens): void {
    this.#rows.set(connectionId, { tokens: { ...tokens }, status: 'connected' });
  }

  status(connectionId: string): DepopTokenStatus | undefined {
    return this.#rows.get(connectionId)?.status;
  }

  /** Test control: the next `times` writes fail, as a database outage would. */
  failWrites(times = 1): void {
    this.#failures = times;
  }

  load(connectionId: string): Promise<DepopTokens | null> {
    const row = this.#rows.get(connectionId);
    return Promise.resolve(row === undefined ? null : { ...row.tokens });
  }

  replace(connectionId: string, usedRefreshToken: string, next: DepopTokens): Promise<boolean> {
    if (this.#failures > 0) {
      this.#failures -= 1;
      return Promise.reject(new Error('the token store is unavailable'));
    }
    const row = this.#rows.get(connectionId);
    if (row?.tokens.refreshToken !== usedRefreshToken) return Promise.resolve(false);
    this.#rows.set(connectionId, { tokens: { ...next }, status: 'connected' });
    return Promise.resolve(true);
  }

  markReauthRequired(connectionId: string, refusedRefreshToken: string): Promise<void> {
    const row = this.#rows.get(connectionId);
    if (row?.tokens.refreshToken === refusedRefreshToken) row.status = 'reauth_required';
    return Promise.resolve();
  }
}

export interface DepopSellerTokensOptions {
  oauth: DepopOAuthClient;
  store: DepopTokenStore;
  /** Access tokens are refreshed this long before they expire. Default 5 minutes. */
  refreshMarginMs?: number;
  /**
   * How long, in all, to keep rereading the store after Depop refuses a refresh token, for the
   * tokens of another process that refreshed first. Default 1.5 seconds.
   */
  refusalGraceMs?: number;
  now?: () => number;
  logger?: Logger;
}

interface ConnectionState {
  /** The newest tokens this process holds; `undefined` until loaded. */
  current: DepopTokens | undefined;
  /**
   * Tokens a refresh returned that the store doesn't hold yet, with the refresh token the store
   * holds instead (the one they replace there, however many refreshes ago).
   */
  unsaved: { storedRefreshToken: string; tokens: DepopTokens } | undefined;
  refreshing: Promise<DepopTokens> | undefined;
}

/** Access tokens for Depop connections, refreshed single-flight from the token store. */
export class DepopSellerTokens {
  readonly #options: DepopSellerTokensOptions;
  readonly #now: () => number;
  readonly #connections = new Map<string, ConnectionState>();

  constructor(options: DepopSellerTokensOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The connection's current access token. Throws `DepopReauthRequiredError` when the seller must
   * connect Depop (again), and `DepopTokenUnavailableError` when Depop can't be asked right now.
   */
  async accessToken(connection: ConnectionRef | null, signal: AbortSignal): Promise<string> {
    if (connection?.mode !== 'api') {
      throw new DepopReauthRequiredError('Connect Depop to list there.');
    }
    const state = this.#state(connection.id);
    await this.#storeUnsaved(connection.id, state);
    const tokens = state.current ?? (await this.#options.store.load(connection.id));
    if (tokens === null) throw new DepopReauthRequiredError('Connect Depop to list there.');
    state.current ??= tokens;
    if (this.#fresh(tokens)) return tokens.accessToken;
    // No caller's signal: the request's deadline is the OAuth client's own timeout.
    state.refreshing ??= this.#refresh(connection.id, state, tokens).finally(() => {
      state.refreshing = undefined;
    });
    return (await untilAborted(state.refreshing, signal)).accessToken;
  }

  /** Depop refused this access token: the next call refreshes (from the same grant). */
  forget(connection: ConnectionRef | null, token: string): void {
    const state = connection === null ? undefined : this.#connections.get(connection.id);
    if (state?.current?.accessToken === token) {
      state.current = { ...state.current, accessExpiresAt: 0 };
    }
  }

  #state(connectionId: string): ConnectionState {
    let state = this.#connections.get(connectionId);
    if (state === undefined) {
      state = { current: undefined, unsaved: undefined, refreshing: undefined };
      this.#connections.set(connectionId, state);
    }
    return state;
  }

  #fresh(tokens: DepopTokens): boolean {
    return tokens.accessExpiresAt - (this.#options.refreshMarginMs ?? 5 * 60_000) > this.#now();
  }

  /** Refreshes `used`, or adopts the tokens another process stored after refreshing first. */
  async #refresh(
    connectionId: string,
    state: ConnectionState,
    used: DepopTokens,
  ): Promise<DepopTokens> {
    let tokens = used;
    // At most twice: once with this process's tokens, once with tokens another process stored.
    for (let round = 0; round < 2; round += 1) {
      let next: DepopTokens;
      try {
        next = await this.#options.oauth.refresh(tokens, new AbortController().signal);
      } catch (error) {
        if (!(error instanceof DepopReauthRequiredError)) throw error;
        const stored = await this.#othersTokens(connectionId, tokens.refreshToken);
        if (stored === null) {
          state.current = undefined;
          await this.#options.store.markReauthRequired(connectionId, tokens.refreshToken);
          throw error;
        }
        state.current = stored;
        if (this.#fresh(stored)) return stored;
        tokens = stored;
        continue;
      }
      // Kept before anything else: Depop has already invalidated `tokens`.
      state.current = next;
      const pending: ConnectionState['unsaved'] = state.unsaved;
      state.unsaved = {
        storedRefreshToken:
          pending === undefined ? tokens.refreshToken : pending.storedRefreshToken,
        tokens: next,
      };
      await this.#storeUnsaved(connectionId, state);
      // The seller may have connected again meanwhile; then the store's tokens are newer.
      return this.#connections.get(connectionId)?.current ?? next;
    }
    throw new DepopReauthRequiredError();
  }

  /**
   * Tokens in the store other than the refused `refreshToken` (another process refreshed first),
   * rereading briefly while that process may still be storing them; `null` when none appear.
   */
  async #othersTokens(connectionId: string, refreshToken: string): Promise<DepopTokens | null> {
    const graceMs = this.#options.refusalGraceMs ?? 1_500;
    const rereads = 3;
    for (let read = 0; read <= rereads; read += 1) {
      const stored = await this.#options.store.load(connectionId);
      if (stored !== null && stored.refreshToken !== refreshToken) return stored;
      if (read < rereads) await sleep(graceMs / rereads);
    }
    return null;
  }

  /** Stores the tokens a refresh returned, if the store doesn't hold them yet. Never throws. */
  async #storeUnsaved(connectionId: string, state: ConnectionState): Promise<void> {
    const unsaved = state.unsaved;
    if (unsaved === undefined) return;
    try {
      const stored = await this.#options.store.replace(
        connectionId,
        unsaved.storedRefreshToken,
        unsaved.tokens,
      );
      if (state.unsaved === unsaved) state.unsaved = undefined;
      if (!stored) {
        // The seller connected again meanwhile: the store's tokens are the ones to use.
        state.current = (await this.#options.store.load(connectionId)) ?? undefined;
      }
    } catch (error) {
      this.#options.logger?.error(
        { err: error, connectionId },
        'storing refreshed Depop tokens failed; they stay in use and are stored on the next call',
      );
    }
  }
}

/** `shared`, unless `signal` aborts first: then this caller alone stops waiting. */
function untilAborted<T>(shared: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DepopTokenUnavailableError('aborted'));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(new DepopTokenUnavailableError('aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    void shared.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

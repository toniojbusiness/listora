/**
 * The session vault (docs/features/automation.md, decision D1): the browser session of each
 * automation connection, stored only sealed by the token vault (vault.ts, the `session` kind,
 * bound to its connection), in `marketplace_connection.token_ciphertext`.
 *
 * - **Link.** The seller logs into the marketplace from the iPhone app; the app hands Listora
 *   the session cookies (never the password), and `linkSession` stores them on the account's
 *   automation connection for that marketplace, creating or reviving it. Every cookie must
 *   belong to the marketplace's own domains.
 * - **Load.** Only the browser runner opens a session (`load`), right before it opens a
 *   browser with it; in AWS only the runner's role may decrypt the session purpose.
 * - **Rotate.** Marketplaces refresh their cookies as the seller browses; after each run the
 *   runner stores the refreshed set (`rotate`), unless the session changed meanwhile.
 * - **Relink.** When the marketplace rejects the session, or shows a check automation must not
 *   pass, `markNeedsRelink` discards the session, marks the connection `reauth_required`, and
 *   opens one `reconnect` task so the seller logs in again. A connection in that state holds no
 *   session (a database constraint), so nothing retries around the check.
 *
 * Every write bumps `credential_version` and every replacement names the version it read, so a
 * runner holding an older session never overwrites a newer link, and a check met with an old
 * session never discards the seller's new one.
 */
import { sql } from 'kysely';

import {
  inTransaction,
  jsonb,
  type ChallengeKind,
  type DbExecutor,
  type DbTransaction,
  type Marketplace,
} from '@listora/db';
import type { Logger } from '@listora/shared';

import {
  cookieOnDomains,
  liveCookies,
  storedSessionSchema,
  type SessionCookie,
  type StoredSession,
} from './session.ts';
import { TokenVaultError, type TokenContext, type TokenVault } from './vault.ts';

export interface ConnectionKey {
  accountId: string;
  connectionId: string;
}

export interface LinkSessionInput {
  accountId: string;
  marketplace: Marketplace;
  cookies: readonly SessionCookie[];
  /** The marketplace's own domains (`poshmark.com`); every cookie must belong to one. */
  cookieDomains: readonly string[];
  /** How the seller's marketplace account is shown, for example its username. */
  displayName?: string | null;
}

export interface LinkedSession {
  connectionId: string;
  /** The `credential_version` the stored session has. */
  version: number;
}

/** A session ready for the runner, at the version it was read. */
export interface LoadedSession extends ConnectionKey {
  marketplace: Marketplace;
  version: number;
  cookies: SessionCookie[];
}

/** The connection a session belongs to, as the token vault binds its ciphertext. */
type SessionOwner = ConnectionKey & { marketplace: Marketplace };

/** Why a session can no longer be used; the message is the seller's to read. */
export interface RelinkReason {
  kind: ChallengeKind | 'session_unreadable';
  message: string;
}

/** The session can't be stored as given (no cookies, a foreign domain, a bad shape). */
export class SessionCookieError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionCookieError';
  }
}

/** The marketplace is connected another way (its API), which a session must not replace. */
export class ConnectionModeConflictError extends Error {
  constructor(marketplace: Marketplace) {
    super(`the ${marketplace} connection uses the marketplace's API, not a browser session`);
    this.name = 'ConnectionModeConflictError';
  }
}

/** The deep link the app opens to log into a marketplace again. */
export function relinkDeepLink(marketplace: Marketplace): string {
  return `listora://connections/${marketplace}`;
}

export interface SessionVaultOptions {
  /** The token vault; only the browser runner's opens sessions (`openSession`). */
  vault: TokenVault;
  logger: Logger;
  /** Seconds since the epoch; tests fix it. */
  nowSeconds?: () => number;
}

export class SessionVault {
  readonly #vault: TokenVault;
  readonly #logger: Logger;
  readonly #nowSeconds: () => number;

  constructor(options: SessionVaultOptions) {
    this.#vault = options.vault;
    this.#logger = options.logger;
    this.#nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Stores a freshly logged-in session on the account's automation connection for the
   * marketplace (created, or revived from any earlier state) and closes its open `reconnect`
   * tasks. Refuses a marketplace connected through its API.
   */
  async linkSession(executor: DbExecutor, input: LinkSessionInput): Promise<LinkedSession> {
    const session = this.#checkedSession(input.cookies, input.cookieDomains);
    return inTransaction(executor, async (trx) => {
      const existing = await trx
        .selectFrom('marketplace_connection')
        .select(['id', 'mode'])
        .where('account_id', '=', input.accountId)
        .where('marketplace', '=', input.marketplace)
        .forUpdate()
        .executeTakeFirst();
      if (existing?.mode === 'api') throw new ConnectionModeConflictError(input.marketplace);

      const connectionId =
        existing?.id ??
        (await sql<{ id: string }>`select uuidv7() as id`.execute(trx)).rows[0]?.id ??
        '';
      const ciphertext = await this.#seal(
        { accountId: input.accountId, connectionId, marketplace: input.marketplace },
        session,
      );
      let version: number;
      if (existing === undefined) {
        const inserted = await trx
          .insertInto('marketplace_connection')
          .values({
            id: connectionId,
            account_id: input.accountId,
            marketplace: input.marketplace,
            mode: 'automation',
            display_name: input.displayName ?? null,
            token_ciphertext: ciphertext,
            status: 'connected',
            last_ok_at: sql<Date>`now()`,
            granted_at: sql<Date>`now()`,
          })
          .returning('credential_version')
          .executeTakeFirstOrThrow();
        version = inserted.credential_version;
      } else {
        const updated = await trx
          .updateTable('marketplace_connection')
          .set({
            mode: 'automation',
            token_ciphertext: ciphertext,
            credential_version: sql<number>`credential_version + 1`,
            status: 'connected',
            last_error: null,
            last_error_code: null,
            last_error_at: null,
            last_ok_at: sql<Date>`now()`,
            granted_at: sql<Date>`now()`,
            ...(input.displayName === undefined ? {} : { display_name: input.displayName }),
          })
          .where('account_id', '=', input.accountId)
          .where('id', '=', connectionId)
          .returning('credential_version')
          .executeTakeFirstOrThrow();
        version = updated.credential_version;
      }
      await closeReconnectTasks(trx, { accountId: input.accountId, connectionId }, 'done');
      return { connectionId, version };
    });
  }

  /**
   * The connection's session, decrypted, with expired cookies dropped; `null` when it has none
   * to use (not an automation connection, or waiting to be relinked). A session that can't be
   * decrypted or read is discarded as if the marketplace had rejected it; a KMS outage throws.
   */
  async load(executor: DbExecutor, key: ConnectionKey): Promise<LoadedSession | null> {
    const row = await executor
      .selectFrom('marketplace_connection')
      .select(['marketplace', 'mode', 'status', 'token_ciphertext', 'credential_version'])
      .where('account_id', '=', key.accountId)
      .where('id', '=', key.connectionId)
      .executeTakeFirst();
    if (row?.mode !== 'automation' || row.token_ciphertext === null) return null;
    if (row.status !== 'connected' && row.status !== 'degraded') return null;
    const session = await this.#open(
      { ...key, marketplace: row.marketplace },
      row.token_ciphertext,
    );
    if (session === null) {
      this.#logger.error(
        { accountId: key.accountId, connectionId: key.connectionId },
        'a stored marketplace session is unreadable; it needs relinking',
      );
      await this.markNeedsRelink(
        executor,
        { ...key, version: row.credential_version },
        {
          kind: 'session_unreadable',
          message: `Listora can't use the saved ${row.marketplace} login. Log in again to keep automating.`,
        },
      );
      return null;
    }
    const cookies = liveCookies(session.cookies, this.#nowSeconds());
    if (cookies.length === 0) {
      await this.markNeedsRelink(
        executor,
        { ...key, version: row.credential_version },
        {
          kind: 'session_rejected',
          message: `The ${row.marketplace} login has expired. Log in again to keep automating.`,
        },
      );
      return null;
    }
    return { ...key, marketplace: row.marketplace, version: row.credential_version, cookies };
  }

  /**
   * Stores the cookies the marketplace refreshed during a run. Only when the session is still
   * the one `loaded` read (same version, still usable); returns whether it was stored. Cookies
   * outside `cookieDomains` are dropped, never stored.
   */
  async rotate(
    executor: DbExecutor,
    loaded: LoadedSession,
    cookies: readonly SessionCookie[],
    cookieDomains: readonly string[],
  ): Promise<boolean> {
    const own = liveCookies(
      cookies.filter((cookie) => cookieOnDomains(cookie, cookieDomains)),
      this.#nowSeconds(),
    );
    if (own.length === 0) return false;
    const ciphertext = await this.#seal(loaded, { cookies: own });
    const updated = await executor
      .updateTable('marketplace_connection')
      .set({
        token_ciphertext: ciphertext,
        credential_version: sql<number>`credential_version + 1`,
        last_ok_at: sql<Date>`now()`,
      })
      .where('account_id', '=', loaded.accountId)
      .where('id', '=', loaded.connectionId)
      .where('mode', '=', 'automation')
      .where('status', 'in', ['connected', 'degraded'])
      .where('credential_version', '=', loaded.version)
      .executeTakeFirst();
    return updated.numUpdatedRows > 0n;
  }

  /**
   * Discards the session `version` and asks the seller to log in again: the connection becomes
   * `reauth_required` with the reason, and one `reconnect` task is open for it. Does nothing
   * (and returns false) when the stored session is no longer that version: the seller already
   * linked a new one, which this check says nothing about.
   */
  async markNeedsRelink(
    executor: DbExecutor,
    key: ConnectionKey & { version: number },
    reason: RelinkReason,
  ): Promise<boolean> {
    return inTransaction(executor, async (trx) => {
      const updated = await trx
        .updateTable('marketplace_connection')
        .set({
          status: 'reauth_required',
          token_ciphertext: null,
          credential_version: sql<number>`credential_version + 1`,
          last_error: reason.message,
          last_error_code: reason.kind,
          last_error_at: sql<Date>`now()`,
        })
        .where('account_id', '=', key.accountId)
        .where('id', '=', key.connectionId)
        .where('mode', '=', 'automation')
        .where('credential_version', '=', key.version)
        .returning('marketplace')
        .executeTakeFirst();
      if (updated === undefined) return false;
      const open = await openReconnectTask(trx, key);
      if (open === undefined) {
        await trx
          .insertInto('user_task')
          .values({
            account_id: key.accountId,
            kind: 'reconnect',
            urgency: 'high',
            deep_link: relinkDeepLink(updated.marketplace),
            payload: jsonb({
              connectionId: key.connectionId,
              marketplace: updated.marketplace,
              reason: reason.kind,
              message: reason.message,
            }),
          })
          .execute();
      }
      this.#logger.warn(
        { accountId: key.accountId, connectionId: key.connectionId, reason: reason.kind },
        'marketplace session needs relinking',
      );
      return true;
    });
  }

  #checkedSession(cookies: readonly SessionCookie[], domains: readonly string[]): StoredSession {
    if (domains.length === 0) throw new SessionCookieError('no cookie domains to check against');
    const parsed = storedSessionSchema.safeParse({ cookies });
    if (!parsed.success) throw new SessionCookieError('the session cookies are not valid');
    const foreign = parsed.data.cookies.find((cookie) => !cookieOnDomains(cookie, domains));
    if (foreign !== undefined) {
      throw new SessionCookieError("a session cookie belongs to another site's domain");
    }
    const live = liveCookies(parsed.data.cookies, this.#nowSeconds());
    if (live.length === 0) throw new SessionCookieError('every session cookie has expired');
    return { cookies: live };
  }

  async #seal(owner: SessionOwner, session: StoredSession): Promise<Buffer> {
    const plaintext = Buffer.from(JSON.stringify(session), 'utf8');
    try {
      return await this.#vault.sealSession(plaintext, contextFor(owner));
    } finally {
      plaintext.fill(0);
    }
  }

  /**
   * The stored session, or `null` when it can never be opened (damaged, sealed under another
   * key, or not a session); a key service outage throws, so the run retries later.
   */
  async #open(owner: SessionOwner, ciphertext: Buffer): Promise<StoredSession | null> {
    let plaintext: Buffer;
    try {
      plaintext = await this.#vault.openSession(ciphertext, contextFor(owner));
    } catch (error) {
      if (error instanceof TokenVaultError && error.kind === 'corrupt') return null;
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(plaintext.toString('utf8'));
    } catch {
      return null;
    } finally {
      plaintext.fill(0);
    }
    const parsed = storedSessionSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  }
}

function contextFor(owner: SessionOwner): TokenContext {
  return { marketplace: owner.marketplace, connectionId: owner.connectionId };
}

async function openReconnectTask(
  trx: DbTransaction,
  key: ConnectionKey,
): Promise<{ id: string } | undefined> {
  return trx
    .selectFrom('user_task')
    .select('id')
    .where('account_id', '=', key.accountId)
    .where('kind', '=', 'reconnect')
    .where('status', '=', 'open')
    .where(sql<string>`payload->>'connectionId'`, '=', key.connectionId)
    .executeTakeFirst();
}

async function closeReconnectTasks(
  trx: DbTransaction,
  key: ConnectionKey,
  status: 'done' | 'dismissed',
): Promise<void> {
  await trx
    .updateTable('user_task')
    .set({ status, completed_at: sql<Date>`now()` })
    .where('account_id', '=', key.accountId)
    .where('kind', '=', 'reconnect')
    .where('status', '=', 'open')
    .where(sql<string>`payload->>'connectionId'`, '=', key.connectionId)
    .execute();
}

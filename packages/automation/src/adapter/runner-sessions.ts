/**
 * Browser sessions in the browser runner (decision D1). For each run, in order:
 *
 * 1. **One at a time per seller.** A Postgres advisory lock on the connection, held for the
 *    whole run, so no two runners (an old one still stopping, say) ever act in the same
 *    seller's account at once.
 * 2. **The session**, loaded from the vault only here, after the lock.
 * 3. **The rate limit**: the seller's account gets at most the marketplace's runs per hour and
 *    per day, counted in `automation_run` across every runner and restart. A run over it opens
 *    nothing and says when to try again.
 * 4. **The pause** since the account's last run started (the profile's `sessionGapMs`).
 * 5. **The run**, recorded in `automation_run` before the browser opens and finished with how
 *    it ended: the failed step, the check it met, the redacted screenshot.
 * 6. **Afterwards**: a check automation must not pass discards the session and asks the seller
 *    to relink (the vault); otherwise the cookies the marketplace refreshed are stored.
 */
import { sql } from 'kysely';

import type { AutomationRunOutcome, Db, Marketplace } from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import { assertNever, type Logger } from '@listora/shared';
import { sameCookies, type LoadedSession, type SessionVault } from '@listora/connections';

import { isAutomatedMarketplace, type AutomationProfile } from '../profiles.ts';
import { challengeMessage } from '../safety/challenges.ts';
import { Pacing, type PacingOptions } from '../safety/pacing.ts';
import { sanitizedError } from '../safety/redaction.ts';
import type { AutomationSession, BrowserRunner, ScriptResult } from '../runner/types.ts';
import type { AutomationSessions, SessionRequest, SessionRun } from './sessions.ts';

export interface RunnerSessionsOptions {
  db: Db;
  vault: SessionVault;
  runner: BrowserRunner;
  /** The configured profile of each automated marketplace. */
  profile: (marketplace: Marketplace) => AutomationProfile | undefined;
  logger: Logger;
  /** For the pause between sessions (tests make it quick). */
  pacing?: PacingOptions;
  /** When another runner holds the seller's session, how soon to try again (default 30 s). */
  busyRetryMs?: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export class RunnerSessions implements AutomationSessions {
  readonly #options: RunnerSessionsOptions;
  readonly #log: Logger;

  constructor(options: RunnerSessionsOptions) {
    this.#options = options;
    this.#log = options.logger.child({ component: 'runner-sessions' });
  }

  async use<T>(
    request: SessionRequest,
    body: (session: AutomationSession, signal: AbortSignal) => Promise<ScriptResult<T>>,
    signal: AbortSignal,
  ): Promise<SessionRun<T>> {
    const { db } = this.#options;
    const connection = await db
      .selectFrom('marketplace_connection')
      .select(['account_id', 'marketplace', 'mode'])
      .where('id', '=', request.connection.id)
      .executeTakeFirst();
    if (connection?.mode !== 'automation' || !isAutomatedMarketplace(connection.marketplace)) {
      return { type: 'no_session' };
    }
    const profile = this.#options.profile(connection.marketplace);
    if (profile === undefined) return { type: 'no_session' };
    const key = { accountId: connection.account_id, connectionId: request.connection.id };

    // A dedicated connection holds the advisory lock for the whole run.
    return db.connection().execute(async (locked) => {
      const lockKey = `automation:${key.connectionId}`;
      const { rows } = await sql<{ acquired: boolean }>`
        select pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) as acquired
      `.execute(locked);
      if (rows[0]?.acquired !== true) {
        return { type: 'busy', retryAfterMs: this.#options.busyRetryMs ?? 30_000 } as const;
      }
      try {
        const loaded = await this.#options.vault.load(db, key);
        if (loaded === null) return { type: 'no_session' } as const;
        const limited = await this.#rateLimit(key, profile);
        if (limited !== null) return { type: 'rate_limited', retryAfterMs: limited } as const;
        await this.#pause(key, profile, signal);
        return await this.#run(request, profile, loaded, body, signal);
      } finally {
        await sql`select pg_advisory_unlock(hashtextextended(${lockKey}, 0))`.execute(locked);
      }
    });
  }

  async #run<T>(
    request: SessionRequest,
    profile: AutomationProfile,
    loaded: LoadedSession,
    body: (session: AutomationSession, signal: AbortSignal) => Promise<ScriptResult<T>>,
    signal: AbortSignal,
  ): Promise<SessionRun<T>> {
    const { db, vault } = this.#options;
    const run = await db
      .insertInto('automation_run')
      .values({
        account_id: loaded.accountId,
        connection_id: loaded.connectionId,
        marketplace: loaded.marketplace,
        purpose: request.purpose,
        script: request.script.slice(0, 100),
        operation_id: request.purpose === 'operation' ? request.operationId : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const log = this.#log.child({ runId: run.id, connectionId: loaded.connectionId });

    let result: ScriptResult<T>;
    let cookies: Awaited<ReturnType<AutomationSession['close']>> = [];
    let opened = false;
    try {
      const session = await this.#options.runner.openSession(
        { profile, cookies: loaded.cookies, accountId: loaded.accountId, runId: run.id },
        signal,
      );
      opened = true;
      try {
        result = await body(session, signal);
      } finally {
        cookies = await session.close();
      }
    } catch (error) {
      log.error({ err: sanitizedError(error), opened }, 'the browser session could not run');
      result = {
        ok: false,
        mutated: false,
        steps: [],
        failure: {
          kind: 'error',
          step: opened ? 'run session' : 'open session',
          // A browser that did not start never asked the marketplace anything.
          code: signal.aborted ? 'aborted' : opened ? 'script_error' : 'browser_unavailable',
          message: opened
            ? 'the browser session stopped unexpectedly'
            : 'the browser could not open the session',
          retryAfterMs: null,
          screenshotKey: null,
        },
      };
    }

    if (!result.ok && result.failure.kind === 'challenge') {
      await vault.markNeedsRelink(
        db,
        { accountId: loaded.accountId, connectionId: loaded.connectionId, version: loaded.version },
        {
          kind: result.failure.challenge,
          message: challengeMessage(
            result.failure.challenge,
            MARKETPLACE_NAMES[loaded.marketplace],
          ),
        },
      );
    } else if (cookies.length > 0 && !sameCookies(loaded.cookies, cookies)) {
      const stored = await vault.rotate(db, loaded, cookies, profile.cookieDomains);
      log.debug({ stored }, 'the marketplace refreshed the session');
    }

    const failure = result.ok ? null : result.failure;
    await db
      .updateTable('automation_run')
      .set({
        finished_at: sql<Date>`now()`,
        outcome: runOutcome(result),
        challenge_kind: failure?.kind === 'challenge' ? failure.challenge : null,
        failed_step: failure === null ? null : failure.step.slice(0, 100),
        error_code:
          failure === null ? null : failure.kind === 'error' ? failure.code : failure.kind,
        screenshot_key: failure?.screenshotKey ?? null,
      })
      .where('account_id', '=', loaded.accountId)
      .where('id', '=', run.id)
      .execute();
    return { type: 'ran', result };
  }

  /** Milliseconds until the account may run again, or `null` when it may now. */
  async #rateLimit(
    key: { accountId: string; connectionId: string },
    profile: AutomationProfile,
  ): Promise<number | null> {
    const windows = [
      { ms: HOUR_MS, limit: profile.limits.runsPerHour },
      { ms: DAY_MS, limit: profile.limits.runsPerDay },
    ];
    let wait: number | null = null;
    for (const window of windows) {
      // The run that has to age out of the window before another fits.
      const { rows } = await sql<{ started_at: Date }>`
        select started_at from automation_run
        where account_id = ${key.accountId} and connection_id = ${key.connectionId}
          and started_at > now() - make_interval(secs => ${window.ms / 1000})
        order by started_at desc
        offset ${window.limit - 1} limit 1
      `.execute(this.#options.db);
      const oldest = rows[0]?.started_at;
      if (oldest !== undefined) {
        const freesAt = oldest.getTime() + window.ms - Date.now();
        wait = Math.max(wait ?? 0, freesAt, 1_000);
      }
    }
    return wait;
  }

  /** Waits out the rest of the pause since the account's last run started. */
  async #pause(
    key: { accountId: string; connectionId: string },
    profile: AutomationProfile,
    signal: AbortSignal,
  ): Promise<void> {
    const last = await this.#options.db
      .selectFrom('automation_run')
      .select('started_at')
      .where('account_id', '=', key.accountId)
      .where('connection_id', '=', key.connectionId)
      .orderBy('started_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (last === undefined) return;
    const pacing = new Pacing(profile.pacing, this.#options.pacing);
    const gap = pacing.delayMs('session');
    await pacing.waitFor(last.started_at.getTime() + gap - Date.now(), signal);
  }
}

function runOutcome(result: ScriptResult<unknown>): AutomationRunOutcome {
  if (result.ok) return 'succeeded';
  const { failure } = result;
  switch (failure.kind) {
    case 'challenge':
      return 'challenge';
    case 'timeout':
      return 'timeout';
    case 'error':
      return failure.code === 'aborted' ? 'canceled' : 'failed';
    default:
      return assertNever(failure, 'script failure');
  }
}

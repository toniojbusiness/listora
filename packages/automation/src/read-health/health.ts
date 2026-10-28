/**
 * Background read health (docs/features/read-health.md): a background read that keeps failing
 * reaches the owner, never silently. Each connection's sale checks, listing imports, and offer
 * checks record whether they worked (`background_read_health`, one row per connection and read).
 * When one fails `alertAfterFailures` times in a row, or has not worked for `noSuccessMs` while
 * failing, the worker emails the owner once for that run of failures, naming the marketplace,
 * the read, the step it stopped at, and its last error in words that say only what the reader
 * knows. A read that works ends the run. The seller never sees any of it: a failing read is
 * Listora's to fix.
 */
import { sql } from 'kysely';

import {
  inTransaction,
  type BackgroundRead,
  type ConnectionStatus,
  type Db,
  type DbExecutor,
  type ExecutionLocation,
  type Marketplace,
} from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import { AutomationReadError } from '../adapter/automation-adapter.ts';

/** The worker's scheduled task that emails the owner about failing reads. */
export const READ_ALERTS_TASK = 'background_read_alerts';
/** Every 5 minutes (UTC crontab fields). */
export const READ_ALERTS_SCHEDULE = '*/5 * * * *';

/** Where the owner reads what an alert means and what to do first. */
export const READ_HEALTH_DOC = 'docs/features/read-health.md';

export interface ReadAlertSettings {
  /** This many failures in a row email the owner (`READ_ALERT_FAILURES`). */
  readonly alertAfterFailures: number;
  /** A failing read that has not worked for this long emails the owner too. */
  readonly noSuccessMs: number;
}

/** Each read's name in an alert and the admin view. */
export const READ_NAMES: Readonly<Record<BackgroundRead, string>> = {
  sale_check: 'sale check',
  listing_import: 'listing import',
  offer_check: 'offer check',
};

/** One connection's read. */
export interface ReadTarget {
  readonly accountId: string;
  readonly connectionId: string;
  readonly marketplace: Marketplace;
  readonly read: BackgroundRead;
}

/** Why a read failed, as the reader knows it: its code, the step, and its own words. */
export interface ReadFailure {
  readonly code: string;
  readonly step: string | null;
  readonly detail: string | null;
}

/**
 * Not failures: Listora pacing its own sessions in the account put the read off, and it runs
 * again shortly.
 */
const NOT_A_FAILURE: ReadonlySet<string> = new Set(['automation_paced', 'automation_busy']);

/** What a read's error was, for the owner: never page content (the script sanitized it). */
export function readFailure(error: unknown): ReadFailure {
  if (error instanceof AutomationReadError) {
    return { code: error.code, step: error.step, detail: error.detail };
  }
  // Listora's own failure, not the marketplace's answer.
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : null;
  return { code: 'error', step: null, detail };
}

/** Records that the read worked: the run of failures, if any, ends. */
export async function recordReadSucceeded(db: DbExecutor, target: ReadTarget): Promise<void> {
  await db
    .insertInto('background_read_health')
    .values({
      account_id: target.accountId,
      connection_id: target.connectionId,
      marketplace: target.marketplace,
      read: target.read,
      last_succeeded_at: sql<Date>`now()`,
    })
    .onConflict((conflict) =>
      conflict.columns(['account_id', 'connection_id', 'read']).doUpdateSet({
        last_succeeded_at: sql<Date>`now()`,
        failures_in_a_row: 0,
        failing_since: null,
        owner_alerted_at: null,
      }),
    )
    .execute();
}

/**
 * Records that the read failed, with its code, step, and detail. A read Listora's pacing put off
 * is not a failure and changes nothing.
 */
export async function recordReadFailed(
  db: DbExecutor,
  target: ReadTarget,
  failure: ReadFailure,
): Promise<void> {
  if (NOT_A_FAILURE.has(failure.code)) return;
  const error = {
    last_error_code: clip(failure.code, 100) ?? 'error',
    last_error_step: clip(failure.step, 200),
    last_error_detail: clip(failure.detail, 500),
  };
  await db
    .insertInto('background_read_health')
    .values({
      account_id: target.accountId,
      connection_id: target.connectionId,
      marketplace: target.marketplace,
      read: target.read,
      last_failed_at: sql<Date>`now()`,
      failures_in_a_row: 1,
      failing_since: sql<Date>`now()`,
      ...error,
    })
    .onConflict((conflict) =>
      conflict.columns(['account_id', 'connection_id', 'read']).doUpdateSet({
        last_failed_at: sql<Date>`now()`,
        failures_in_a_row: sql<number>`background_read_health.failures_in_a_row + 1`,
        failing_since: sql<Date>`coalesce(background_read_health.failing_since, now())`,
        ...error,
      }),
    )
    .execute();
}

function clip(text: string | null, max: number): string | null {
  const line = text?.replace(/\s+/g, ' ').trim() ?? '';
  return line === '' ? null : line.slice(0, max);
}

/** Why a failing read is a problem the owner hears about. */
export type ReadProblemReason = 'failures_in_a_row' | 'no_success';

/** What the thresholds look at. */
export interface ReadState {
  readonly failuresInARow: number;
  readonly failingSince: Date | null;
  readonly lastSucceededAt: Date | null;
}

/**
 * Whether a read's state is a problem: `alertAfterFailures` failures in a row, or failing with
 * no success for `noSuccessMs` (since the first failure, for a read that never worked). A read
 * that works, or has not failed since it last did, is never one.
 */
export function readProblem(
  state: ReadState,
  now: Date,
  settings: ReadAlertSettings,
): ReadProblemReason | null {
  if (state.failuresInARow === 0 || state.failingSince === null) return null;
  if (state.failuresInARow >= settings.alertAfterFailures) return 'failures_in_a_row';
  const since = state.lastSucceededAt ?? state.failingSince;
  return now.getTime() - since.getTime() >= settings.noSuccessMs ? 'no_success' : null;
}

/**
 * What a failure code means, as far as the reader knows it. A page without what the reader
 * expected (`element_missing`) does not prove the page changed: a page still drawing its rows, a
 * slow one, or a shape the reader does not handle yet fails the same way, so the words never say
 * it changed.
 */
export function readFailureReason(code: string): string {
  switch (code) {
    case 'element_missing':
      return "The page did not have what Listora's reader expected. This does not prove the page changed: a page still loading its rows, or a page shape the reader does not handle, fails the same way.";
    case 'step_timeout':
    case 'timeout':
      return 'The step ran out of time before the page had what it waits for.';
    case 'rate_limited':
      return 'The marketplace answered 429: it asked Listora to slow down.';
    case 'server_error':
      return 'The marketplace answered with a server error, or its page said it failed.';
    case 'unreachable':
      return 'The marketplace could not be reached (network or DNS).';
    case 'browser_unavailable':
      return "Listora's browser did not start, so the marketplace was never asked.";
    case 'script_error':
      return "Listora's reader itself failed: a bug in its script.";
    case 'stopped_for_check':
      return 'The marketplace showed a check the seller completes on their iPhone.';
    case 'aborted':
    case 'phone_stopped':
    case 'interrupted':
      return 'The read stopped before it finished (its deadline, or the runner or the app stopped).';
    case 'no_session':
      return 'Listora has no stored sign-in for the account to read with.';
    case 'captcha':
    case 'bot_check':
    case 'login_challenge':
    case 'session_rejected':
    case 'unexpected_page':
      return 'The marketplace asked to sign in again, or showed a check Listora must not pass.';
    case 'unsupported':
      return 'No reader exists for this on the marketplace yet.';
    case 'error':
    case 'read_failed':
      return "Listora failed while reading, on Listora's side (not the marketplace's answer).";
    default:
      return `The reader stopped with the code ${code}.`;
  }
}

/** One failing read the owner is told about. */
export interface ReadAlert {
  readonly accountId: string;
  readonly connectionId: string;
  readonly marketplace: Marketplace;
  readonly read: BackgroundRead;
  readonly reason: ReadProblemReason;
  readonly failuresInARow: number;
  readonly failingSince: Date;
  readonly lastSucceededAt: Date | null;
  readonly lastFailedAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorStep: string | null;
  readonly lastErrorDetail: string | null;
  readonly connectionStatus: ConnectionStatus;
  readonly runsOn: ExecutionLocation;
  readonly readOnly: boolean;
}

/** An email to the owner. */
export interface OwnerEmail {
  readonly subject: string;
  readonly text: string;
}

/** Sends the owner an email, or throws. */
export interface OwnerMailer {
  send(email: OwnerEmail): Promise<void>;
}

function hoursBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 3_600_000);
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`;
}

/** The owner's email for a failing read; `environment` tags the subject as alarm emails are. */
export function readAlertEmail(alert: ReadAlert, environment: string, now: Date): OwnerEmail {
  const name = MARKETPLACE_NAMES[alert.marketplace];
  const read = READ_NAMES[alert.read];
  const what = `${name} ${read}`;
  const headline =
    alert.reason === 'failures_in_a_row'
      ? `${what} failed ${plural(alert.failuresInARow, 'time')} in a row`
      : `${what} has not worked for ${plural(
          hoursBetween(alert.lastSucceededAt ?? alert.failingSince, now),
          'hour',
        )}`;
  const step = alert.lastErrorStep ?? '(before any step ran)';
  const lastWorked =
    alert.lastSucceededAt === null
      ? 'never'
      : `${alert.lastSucceededAt.toISOString()} (${plural(hoursBetween(alert.lastSucceededAt, now), 'hour')} ago)`;
  return {
    subject: `[Listora ${environment}] ${headline}`,
    text: [
      `${headline}.`,
      '',
      `Marketplace: ${name}`,
      `Read: ${read}`,
      `Step: ${step}`,
      `Last error: ${alert.lastErrorCode ?? 'error'}`,
      `What it means: ${readFailureReason(alert.lastErrorCode ?? 'error')}`,
      `Reader's words: ${alert.lastErrorDetail ?? '(none recorded)'}`,
      `Failed in a row: ${String(alert.failuresInARow)}, since ${alert.failingSince.toISOString()}`,
      `Last failed: ${alert.lastFailedAt?.toISOString() ?? '-'}`,
      `Last worked: ${lastWorked}`,
      '',
      `Account: ${alert.accountId}`,
      `Connection: ${alert.connectionId} (${alert.connectionStatus}, runs on ${alert.runsOn === 'phone' ? 'the iPhone' : 'the cloud'}${alert.readOnly ? ', read only' : ''})`,
      '',
      'The seller is not told: a working connection whose reads fail is for Listora to fix.',
      `Every connection's reads and when each last worked: npm run admin -- read-health --account ${alert.accountId}`,
      `(in AWS: scripts/admin-remote.sh ${environment} -- read-health --account ${alert.accountId}).`,
      `What this alert means and what to do first: ${READ_HEALTH_DOC} in the Listora repository.`,
    ].join('\n'),
  };
}

export interface ReadAlertDependencies {
  db: Db;
  settings: ReadAlertSettings;
  mailer: OwnerMailer;
  /** `personal`, `staging`, `prod`, or `local`: the subject's tag. */
  environment: string;
  logger: Logger;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: () => number;
}

/**
 * One round of the scheduled task: emails the owner about every failing read of a working
 * automation connection that crossed a threshold and was not emailed about yet. The claim
 * (`owner_alerted_at`) and the email go together: a send that fails rolls the claim back, so
 * the next round tries again, and an alert is never marked sent when it was not. A connection
 * only the seller can fix (`reauth_required`, `revoked`) has its own reconnect card and alarm.
 */
export async function runReadAlerts(
  deps: ReadAlertDependencies,
): Promise<{ alerted: number; failed: number }> {
  const { db } = deps;
  const now = new Date(deps.now?.() ?? Date.now());
  const log = deps.logger.child({ task: READ_ALERTS_TASK });
  const candidates = await failingReads(db)
    .select(['health.account_id', 'health.connection_id', 'health.read'])
    .where('health.owner_alerted_at', 'is', null)
    .orderBy('health.failing_since')
    .limit(500)
    .execute();
  let alerted = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const fields: Record<string, unknown> = {
      accountId: candidate.account_id,
      connectionId: candidate.connection_id,
      read: candidate.read,
    };
    try {
      const sent = await inTransaction(db, async (trx) => {
        // Read again under the row's lock: a read that finished meanwhile counts.
        const row = await failingReads(trx)
          .select([
            'health.marketplace',
            'health.failures_in_a_row',
            'health.failing_since',
            'health.last_succeeded_at',
            'health.last_failed_at',
            'health.last_error_code',
            'health.last_error_step',
            'health.last_error_detail',
            'connection.status',
            'connection.runs_on',
            'connection.read_only',
          ])
          .where('health.account_id', '=', candidate.account_id)
          .where('health.connection_id', '=', candidate.connection_id)
          .where('health.read', '=', candidate.read)
          .where('health.owner_alerted_at', 'is', null)
          .forUpdate('health')
          .executeTakeFirst();
        if (row === undefined || row.failing_since === null) return false;
        const reason = readProblem(
          {
            failuresInARow: row.failures_in_a_row,
            failingSince: row.failing_since,
            lastSucceededAt: row.last_succeeded_at,
          },
          now,
          deps.settings,
        );
        if (reason === null) return false;
        const alert: ReadAlert = {
          accountId: candidate.account_id,
          connectionId: candidate.connection_id,
          marketplace: row.marketplace,
          read: candidate.read,
          reason,
          failuresInARow: row.failures_in_a_row,
          failingSince: row.failing_since,
          lastSucceededAt: row.last_succeeded_at,
          lastFailedAt: row.last_failed_at,
          lastErrorCode: row.last_error_code,
          lastErrorStep: row.last_error_step,
          lastErrorDetail: row.last_error_detail,
          connectionStatus: row.status,
          runsOn: row.runs_on,
          readOnly: row.read_only,
        };
        Object.assign(fields, {
          marketplace: alert.marketplace,
          reason,
          failuresInARow: alert.failuresInARow,
          code: alert.lastErrorCode,
          step: alert.lastErrorStep,
        });
        await trx
          .updateTable('background_read_health')
          .set({ owner_alerted_at: now })
          .where('account_id', '=', candidate.account_id)
          .where('connection_id', '=', candidate.connection_id)
          .where('read', '=', candidate.read)
          .execute();
        await deps.mailer.send(readAlertEmail(alert, deps.environment, now));
        return true;
      });
      if (!sent) continue;
      alerted += 1;
      log.warn({ event: 'read_alert', ...fields }, 'emailed the owner about a failing read');
    } catch (error) {
      failed += 1;
      log.error(
        {
          event: 'read_alert_failed',
          ...fields,
          err: error instanceof Error ? { name: error.name, message: error.message } : error,
        },
        'the owner could not be emailed about a failing read; the next round tries again',
      );
    }
  }
  return { alerted, failed };
}

/** The failing reads of working automation connections. */
function failingReads(db: DbExecutor) {
  return db
    .selectFrom('background_read_health as health')
    .innerJoin('marketplace_connection as connection', (join) =>
      join
        .onRef('connection.account_id', '=', 'health.account_id')
        .onRef('connection.id', '=', 'health.connection_id'),
    )
    .where('health.failing_since', 'is not', null)
    .where('connection.mode', '=', 'automation')
    .where('connection.status', 'in', ['connected', 'degraded']);
}

/**
 * The one place that changes an operation's status. Each change, in the caller's transaction:
 *
 * 1. is checked against the state machine (state-machine.ts);
 * 2. updates the row only if it is still in the status and attempt the caller read (a fencing
 *    check, so a stale worker can never overwrite a newer result);
 * 3. appends an `operation_event` with a redacted detail;
 * 4. schedules the operation's next step when the new status has one, and lets the next
 *    operation on the listing run when this one is settled.
 *
 * `succeeded` can only be set with a `SuccessProof` (evidence.ts).
 */
import { sql, type RawBuilder, type Selectable } from 'kysely';

import {
  jsonb,
  type DbTransaction,
  type JsonObject,
  type MarketplaceOperationTable,
  type OperationStatus,
} from '@listora/db';
import { assertNever, redactForStorage } from '@listora/shared';

import type { SuccessProof } from './evidence.ts';
import { ConcurrentOperationChangeError, InvalidTransitionError } from './errors.ts';
import { OPERATION_PRIORITY, scheduleOperationJob } from './jobs.ts';
import { canTransition, isScheduled, isSettled } from './state-machine.ts';

export type OperationRow = Selectable<MarketplaceOperationTable>;

/** A user-readable reason, stored on the operation and in its event. */
export interface OperationError {
  code: string;
  message: string;
}

export type OperationChange =
  /** A step starts; its request may be sent from now on. Adds one attempt. */
  | { to: 'running' }
  /** The next attempt runs after `delayMs`. */
  | { to: 'retrying'; delayMs: number; error: OperationError; attempts?: number }
  /** The listing is read back after `delayMs` to learn the result. */
  | { to: 'verifying'; delayMs: number; error?: OperationError; attempts?: number }
  | { to: 'needs_user_action' }
  | { to: 'succeeded'; proof: SuccessProof; attempts?: number }
  | { to: 'failed'; error: OperationError; attempts?: number }
  /** The user retries a failed operation: a fresh set of attempts, starting now. */
  | { to: 'queued' }
  | { to: 'canceled' };

/** Delists after a sale run ahead of routine changes on other listings. */
export function operationPriority(op: Pick<OperationRow, 'origin'>): number {
  return op.origin === 'auto_delist' ? OPERATION_PRIORITY.urgent : OPERATION_PRIORITY.normal;
}

export async function transitionOperation(
  trx: DbTransaction,
  op: OperationRow,
  change: OperationChange,
  detail: Record<string, unknown> = {},
): Promise<OperationRow> {
  if (!canTransition(op.status, change.to)) {
    throw new InvalidTransitionError(op.id, op.status, change.to);
  }
  const update = columnsFor(op, change);

  const updated = await trx
    .updateTable('marketplace_operation')
    .set(update.columns)
    .where('account_id', '=', op.account_id)
    .where('id', '=', op.id)
    .where('status', '=', op.status)
    .where('attempts', '=', op.attempts)
    .returningAll()
    .executeTakeFirst();
  if (updated === undefined) throw new ConcurrentOperationChangeError(op.id);

  await trx
    .insertInto('operation_event')
    .values({
      account_id: op.account_id,
      operation_id: op.id,
      from_status: op.status,
      to_status: updated.status,
      attempt: updated.attempts,
      error_code: update.eventErrorCode,
      detail: jsonb(eventDetail({ ...detail, ...update.detail })),
    })
    .execute();

  if (isScheduled(updated.status)) {
    await scheduleOperationJob(trx, {
      accountId: updated.account_id,
      operationId: updated.id,
      listingId: updated.listing_id,
      priority: operationPriority(updated),
      runAt: updated.next_attempt_at,
    });
  }
  if (isSettled(updated.status)) await wakeNextOperation(trx, updated);
  return updated;
}

/**
 * Moves a waiting operation's next attempt to now, keeping its status, attempts, and error
 * (an operator's try-now, commands.ts), with an event in its history and its job run at once.
 */
export async function attemptNow(
  trx: DbTransaction,
  op: OperationRow,
  detail: Record<string, unknown>,
): Promise<OperationRow> {
  const moved = await trx
    .updateTable('marketplace_operation')
    .set({ next_attempt_at: sql<Date>`now()` })
    .where('account_id', '=', op.account_id)
    .where('id', '=', op.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('operation_event')
    .values({
      account_id: op.account_id,
      operation_id: op.id,
      from_status: op.status,
      to_status: op.status,
      attempt: op.attempts,
      error_code: op.error_code,
      detail: jsonb(eventDetail(detail)),
    })
    .execute();
  await scheduleOperationJob(trx, {
    accountId: op.account_id,
    operationId: op.id,
    listingId: op.listing_id,
    priority: operationPriority(op),
    runAt: moved.next_attempt_at,
  });
  return moved;
}

/** Stores a detail object as JSON with credentials removed (`redactForStorage`). */
export function eventDetail(detail: Record<string, unknown>): JsonObject {
  const redacted = redactForStorage(detail);
  return typeof redacted === 'object' && redacted !== null && !Array.isArray(redacted)
    ? redacted
    : {};
}

/**
 * Lets the oldest operation that is waiting behind this one on the same listing run now, instead
 * of at its next periodic recheck.
 */
export async function wakeNextOperation(trx: DbTransaction, op: OperationRow): Promise<void> {
  const next = await trx
    .selectFrom('marketplace_operation')
    .selectAll()
    .where('account_id', '=', op.account_id)
    .where('listing_id', '=', op.listing_id)
    .where('status', '=', 'queued')
    .where('id', '<>', op.id)
    .orderBy('created_at')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  if (next === undefined) return;
  await scheduleOperationJob(trx, {
    accountId: next.account_id,
    operationId: next.id,
    listingId: next.listing_id,
    priority: operationPriority(next),
    runAt: null,
  });
}

interface ColumnUpdate {
  columns: {
    status: OperationStatus;
    attempts: number;
    next_attempt_at: RawBuilder<Date> | null;
    success_evidence?: SuccessProof['evidence'] | null;
    error_code?: string | null;
    error_message?: string | null;
  };
  eventErrorCode: string | null;
  detail: Record<string, unknown>;
}

function columnsFor(op: OperationRow, change: OperationChange): ColumnUpdate {
  const cleared = { success_evidence: null, error_code: null, error_message: null };
  switch (change.to) {
    case 'running':
      // The last error stays visible while the next attempt runs.
      return {
        columns: { status: 'running', attempts: op.attempts + 1, next_attempt_at: null },
        eventErrorCode: null,
        detail: {},
      };
    case 'retrying':
    case 'verifying':
      return {
        columns: {
          status: change.to,
          attempts: change.attempts ?? op.attempts,
          next_attempt_at: sql<Date>`now() + make_interval(secs => ${change.delayMs / 1000})`,
          ...cleared,
          ...(change.error === undefined
            ? {}
            : { error_code: change.error.code, error_message: change.error.message }),
        },
        eventErrorCode: change.error?.code ?? null,
        detail: {
          delayMs: change.delayMs,
          ...(change.error === undefined ? {} : { error: change.error }),
        },
      };
    case 'needs_user_action':
      return {
        columns: {
          status: 'needs_user_action',
          attempts: op.attempts,
          next_attempt_at: null,
          ...cleared,
        },
        eventErrorCode: null,
        detail: {},
      };
    case 'succeeded':
      return {
        columns: {
          status: 'succeeded',
          attempts: change.attempts ?? op.attempts,
          next_attempt_at: null,
          ...cleared,
          success_evidence: change.proof.evidence,
        },
        eventErrorCode: null,
        detail: change.proof.detail,
      };
    case 'failed':
      return {
        columns: {
          status: 'failed',
          attempts: change.attempts ?? op.attempts,
          next_attempt_at: null,
          ...cleared,
          error_code: change.error.code,
          error_message: change.error.message,
        },
        eventErrorCode: change.error.code,
        detail: { error: change.error },
      };
    case 'queued':
      return {
        columns: { status: 'queued', attempts: 0, next_attempt_at: sql<Date>`now()`, ...cleared },
        eventErrorCode: null,
        detail: {},
      };
    case 'canceled':
      return {
        columns: { status: 'canceled', attempts: op.attempts, next_attempt_at: null, ...cleared },
        eventErrorCode: null,
        detail: {},
      };
    default:
      return assertNever(change, 'operation change');
  }
}

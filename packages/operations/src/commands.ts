/**
 * Operation commands for the API and the auto-delist orchestrator. Each runs in the caller's
 * transaction when given one, otherwise in its own, so the operation change, its history
 * event, and its job commit together or not at all.
 */
import { sql } from 'kysely';

import {
  inTransaction,
  jsonb,
  type DbExecutor,
  type DbTransaction,
  type JsonObject,
  type OperationKind,
  type OperationOrigin,
} from '@listora/db';
import {
  desiredStateForContent,
  desiredStateToJson,
  isContentKind,
  listingContentToJson,
  parseDesiredListingState,
  parseListingContent,
  type ContentKind,
  type DesiredListingState,
  type ListingContent,
} from '@listora/marketplaces';

import { validateDesiredState } from './desired.ts';
import { confirmByUser } from './evidence.ts';
import {
  IdempotencyConflictError,
  InvalidOperationError,
  InvalidTransitionError,
  NotAccountMemberError,
  OperationNotFoundError,
  SupersededOperationError,
} from './errors.ts';
import { wasSentThroughApi } from './history.ts';
import { syncItemListedStatus } from './item-status.ts';
import { removeOperationJob, scheduleOperationJob } from './jobs.ts';
import { createdAfter } from './ordering.ts';
import { assertWritableListing } from './read-only.ts';
import {
  attemptNow,
  eventDetail,
  operationPriority,
  transitionOperation,
  type OperationRow,
} from './transitions.ts';

interface NewOperationBase {
  accountId: string;
  listingId: string;
  /** Chosen by the caller and unique per account; enqueueing the same key again is a no-op. */
  idempotencyKey: string;
  origin: OperationOrigin;
  /** Required for `auto_delist` operations. */
  delistRunId?: string | null;
}

/**
 * A create, revise, or relist publishes listing content: the item snapshot and the
 * marketplace variant, as they are now. The state its read-back must show comes from the same
 * content (`desiredStateForContent`), so what is sent and what is verified cannot disagree.
 * Every other kind names the desired state itself.
 */
export type NewOperation = NewOperationBase &
  (
    | { kind: ContentKind; content: ListingContent }
    | { kind: Exclude<OperationKind, ContentKind>; desired: DesiredListingState }
  );

export interface EnqueueResult {
  operation: OperationRow;
  /** False when an operation with this idempotency key already existed. */
  created: boolean;
}

/**
 * Records a new `queued` operation and enqueues its job in the same transaction. Enqueueing
 * the same idempotency key again returns the existing operation; reusing a key for a different
 * operation throws `IdempotencyConflictError`. A change to a listing on a read-only connection
 * throws `ReadOnlyConnectionError` and queues nothing (read-only.ts).
 */
export async function enqueueOperation(
  executor: DbExecutor,
  input: NewOperation,
): Promise<EnqueueResult> {
  const intent = operationIntent(input);
  const desired = desiredStateToJson(intent.desired);
  const content = intent.content === null ? null : listingContentToJson(intent.content);
  const delistRunId = input.delistRunId ?? null;
  if ((input.origin === 'auto_delist') !== (delistRunId !== null)) {
    throw new InvalidOperationError('Auto-delist operations, and only those, need a delist run');
  }

  return inTransaction(executor, async (trx) => {
    await assertWritableListing(trx, {
      accountId: input.accountId,
      listingId: input.listingId,
      kind: input.kind,
    });
    const inserted = await trx
      .insertInto('marketplace_operation')
      .values({
        account_id: input.accountId,
        listing_id: input.listingId,
        kind: input.kind,
        idempotency_key: input.idempotencyKey,
        desired: jsonb(desired),
        content: content === null ? null : jsonb(content),
        origin: input.origin,
        delist_run_id: delistRunId,
        next_attempt_at: sql<Date>`now()`,
      })
      .onConflict((conflict) => conflict.columns(['account_id', 'idempotency_key']).doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted === undefined) {
      const existing = await trx
        .selectFrom('marketplace_operation')
        .selectAll()
        .where('account_id', '=', input.accountId)
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirstOrThrow();
      // jsonb reorders keys, so compare both states and contents in their canonical order.
      const same =
        existing.listing_id === input.listingId &&
        existing.kind === input.kind &&
        JSON.stringify(desiredStateToJson(parseDesiredListingState(existing.desired))) ===
          JSON.stringify(desired) &&
        JSON.stringify(
          existing.content === null
            ? null
            : listingContentToJson(parseListingContent(existing.content)),
        ) === JSON.stringify(content);
      if (!same) throw new IdempotencyConflictError(input.idempotencyKey);
      return { operation: existing, created: false };
    }

    await trx
      .insertInto('operation_event')
      .values({
        account_id: inserted.account_id,
        operation_id: inserted.id,
        from_status: null,
        to_status: 'queued',
        attempt: 0,
        detail: jsonb(eventDetail({ kind: inserted.kind, origin: inserted.origin })),
      })
      .execute();
    await scheduleOperationJob(trx, {
      accountId: inserted.account_id,
      operationId: inserted.id,
      listingId: inserted.listing_id,
      priority: operationPriority(inserted),
      runAt: null,
    });
    return { operation: inserted, created: true };
  });
}

/**
 * The desired state and content of a new operation, validated for its kind. Checked at run time
 * too, since a caller that is not type-checked can send any shape.
 */
function operationIntent(input: NewOperation): {
  desired: DesiredListingState;
  content: ListingContent | null;
} {
  const { kind } = input;
  const content: unknown = 'content' in input ? input.content : undefined;
  if (isContentKind(kind)) {
    if (content === undefined) {
      throw new InvalidOperationError(`A ${kind} operation needs the listing content`);
    }
    let parsed: ListingContent;
    try {
      parsed = parseListingContent(content);
    } catch (error) {
      throw new InvalidOperationError(error instanceof Error ? error.message : String(error));
    }
    return {
      desired: validateDesiredState(kind, desiredStateForContent(kind, parsed)),
      content: parsed,
    };
  }
  if (content !== undefined) {
    throw new InvalidOperationError(`A ${kind} operation carries no listing content`);
  }
  const desired: unknown = 'desired' in input ? input.desired : undefined;
  return { desired: validateDesiredState(kind, desired), content: null };
}

export interface OperationTarget {
  accountId: string;
  operationId: string;
}

/**
 * The Retry action: a failed operation gets a fresh set of attempts. Its first step reads the
 * listing back before sending anything, because an earlier attempt may have been applied.
 * Refused when a newer operation exists on the listing, since retrying would undo it, and for a
 * change while the listing's connection is read only.
 */
export async function retryOperation(
  executor: DbExecutor,
  target: OperationTarget,
): Promise<OperationRow> {
  return inTransaction(executor, async (trx) => {
    const op = await lockOperation(trx, target);
    if (op.status !== 'failed') throw new InvalidTransitionError(op.id, op.status, 'queued');
    await assertWritableListing(trx, {
      accountId: op.account_id,
      listingId: op.listing_id,
      kind: op.kind,
    });
    const newer = await trx
      .selectFrom('marketplace_operation')
      .select('id')
      .where('account_id', '=', op.account_id)
      .where('listing_id', '=', op.listing_id)
      .where('status', '<>', 'canceled')
      .where(createdAfter(op))
      .limit(1)
      .executeTakeFirst();
    if (newer !== undefined) throw new SupersededOperationError(op.id);
    return transitionOperation(trx, op, { to: 'queued' }, { action: 'retry' });
  });
}

/**
 * Try now: an operation waiting for its next attempt (`retrying`, or `verifying` between
 * read-backs) runs that attempt at once instead of at its scheduled time. It keeps its status,
 * attempts, and error, and the attempt runs through the state machine exactly as it would have
 * later (a retry reads the listing back before sending anything); only the time moves, and the
 * operation's history records the move (with the operator, from the admin tool). Refused for any
 * other status, so it never starts a step that is running or one the user must do.
 */
export async function tryOperationNow(
  executor: DbExecutor,
  target: OperationTarget & { actor?: string },
): Promise<OperationRow> {
  return inTransaction(executor, async (trx) => {
    const op = await lockOperation(trx, target);
    if (op.status !== 'retrying' && op.status !== 'verifying') {
      throw new InvalidTransitionError(op.id, op.status, 'running');
    }
    return attemptNow(trx, op, {
      action: 'try_now',
      ...(target.actor === undefined ? {} : { actor: target.actor }),
    });
  });
}

/**
 * Cancels an operation that has not started a step (queued, waiting to retry, or waiting for
 * the user). A running or verifying operation may already have reached the marketplace, so it
 * must finish first.
 */
export async function cancelOperation(
  executor: DbExecutor,
  target: OperationTarget & { reason?: string },
): Promise<OperationRow> {
  return inTransaction(executor, async (trx) => {
    const op = await lockOperation(trx, target);
    const canceled = await transitionOperation(
      trx,
      op,
      { to: 'canceled' },
      { action: 'cancel', ...(target.reason === undefined ? {} : { reason: target.reason }) },
    );
    await removeOperationJob(trx, op.id);
    await dismissOpenTasks(trx, op);
    return canceled;
  });
}

/** Edits and refreshes: what they change no longer matters once the listing is delisted. */
const EDIT_KINDS = ['revise', 'price', 'refresh'] as const satisfies readonly OperationKind[];
/** Publishes: they put a listing on the marketplace. */
const PUBLISH_KINDS = ['create', 'relist'] as const satisfies readonly OperationKind[];

/**
 * Before the delist that follows a sale (the auto-delist orchestrator), cancels the listing's
 * operations that the sale made moot and that can be canceled without losing track of what is on
 * the marketplace:
 *
 * - edits (revise, price) and scheduled refreshes waiting to run or to retry, whatever an
 *   earlier attempt did: the delist ends the listing, and its own read-back decides;
 * - publishes (create, relist) waiting to run or to retry that never went through the API, so
 *   nothing of them reached the marketplace and a sold item is never published.
 *
 * Running and verifying operations, and publishes that may have reached the marketplace, are
 * left to finish: their read-backs may find a live listing the delist must end. Operations that
 * wait for the user are left to the delist, which supersedes them when it runs. Each canceled
 * operation records `reason` in its history, and its open tasks are dismissed. Returns the
 * canceled operations' ids, oldest first.
 */
export async function cancelMootOperations(
  executor: DbExecutor,
  target: { accountId: string; listingId: string; reason: string; detail?: JsonObject },
): Promise<string[]> {
  return inTransaction(executor, async (trx) => {
    const waiting = await trx
      .selectFrom('marketplace_operation')
      .selectAll()
      .where('account_id', '=', target.accountId)
      .where('listing_id', '=', target.listingId)
      .where('status', 'in', ['queued', 'retrying'])
      .where('kind', 'in', [...EDIT_KINDS, ...PUBLISH_KINDS])
      .orderBy('created_at')
      .orderBy('id')
      .forUpdate()
      .execute();
    const canceled: string[] = [];
    for (const op of waiting) {
      const publish = (PUBLISH_KINDS as readonly OperationKind[]).includes(op.kind);
      if (publish && (await wasSentThroughApi(trx, op))) continue;
      await transitionOperation(
        trx,
        op,
        { to: 'canceled' },
        { ...target.detail, action: 'supersede', reason: target.reason },
      );
      await removeOperationJob(trx, op.id);
      await dismissOpenTasks(trx, op);
      canceled.push(op.id);
    }
    return canceled;
  });
}

/**
 * After the sale behind a delist run is canceled or returned, the seller may keep the item
 * listed, so the run's delists that can still be stopped without losing track of the
 * marketplace are canceled: those waiting to run or retry that were never sent through the
 * API, and assisted ones waiting for the user (their tasks are dismissed). A delist that may
 * have reached the marketplace finishes, and its read-back records what is true. Each canceled
 * operation records `reason` in its history. Returns the canceled operations' ids, oldest first.
 */
export async function cancelUnsentDelists(
  executor: DbExecutor,
  target: { accountId: string; delistRunId: string; reason: string; detail?: JsonObject },
): Promise<string[]> {
  return inTransaction(executor, async (trx) => {
    const waiting = await trx
      .selectFrom('marketplace_operation')
      .selectAll()
      .where('account_id', '=', target.accountId)
      .where('delist_run_id', '=', target.delistRunId)
      .where('status', 'in', ['queued', 'retrying', 'needs_user_action'])
      .orderBy('created_at')
      .orderBy('id')
      .forUpdate()
      .execute();
    const canceled: string[] = [];
    for (const op of waiting) {
      if (op.status !== 'needs_user_action' && (await wasSentThroughApi(trx, op))) continue;
      await transitionOperation(
        trx,
        op,
        { to: 'canceled' },
        { ...target.detail, action: 'cancel', reason: target.reason },
      );
      await removeOperationJob(trx, op.id);
      await dismissOpenTasks(trx, op);
      canceled.push(op.id);
    }
    return canceled;
  });
}

/** Dismisses an operation's open user tasks, which no longer finish it. */
export async function dismissOpenTasks(
  trx: DbTransaction,
  op: Pick<OperationRow, 'account_id' | 'id'>,
): Promise<void> {
  await trx
    .updateTable('user_task')
    .set({ status: 'dismissed', completed_at: sql<Date>`now()` })
    .where('account_id', '=', op.account_id)
    .where('operation_id', '=', op.id)
    .where('status', '=', 'open')
    .execute();
}

/**
 * The user confirms they did an assisted step (for example deleted the Poshmark listing). This
 * is the only way an operation waiting for the user can succeed.
 */
export async function confirmOperationByUser(
  executor: DbExecutor,
  target: OperationTarget & { userId: string },
): Promise<OperationRow> {
  return inTransaction(executor, async (trx) => {
    const op = await lockOperation(trx, target);
    if (op.status !== 'needs_user_action') {
      throw new InvalidTransitionError(op.id, op.status, 'succeeded');
    }
    const member = await trx
      .selectFrom('membership')
      .select('user_id')
      .where('account_id', '=', op.account_id)
      .where('user_id', '=', target.userId)
      .executeTakeFirst();
    if (member === undefined) throw new NotAccountMemberError();

    const succeeded = await transitionOperation(trx, op, {
      to: 'succeeded',
      proof: confirmByUser(target.userId),
    });
    await trx
      .updateTable('user_task')
      .set({ status: 'done', completed_at: sql<Date>`now()` })
      .where('account_id', '=', op.account_id)
      .where('operation_id', '=', op.id)
      .where('status', '=', 'open')
      .execute();

    // The user's word, not the marketplace's: the status changes and `user_confirmed_at`
    // records the confirmation, but `last_verified_at` and `remote_snapshot` (read-backs only)
    // stay as they were.
    const status = validateDesiredState(op.kind, op.desired).status;
    if (status !== undefined) {
      await trx
        .updateTable('marketplace_listing')
        .set({ status, user_confirmed_at: sql<Date>`now()` })
        .where('account_id', '=', op.account_id)
        .where('id', '=', op.listing_id)
        .execute();
      const { item_id: itemId } = await trx
        .selectFrom('marketplace_listing')
        .select('item_id')
        .where('account_id', '=', op.account_id)
        .where('id', '=', op.listing_id)
        .executeTakeFirstOrThrow();
      await syncItemListedStatus(trx, op.account_id, itemId);
    }
    return succeeded;
  });
}

/**
 * The user dismisses an assisted step without doing it. Dismissing never counts as doing the
 * work: the operation fails, so the listing shows the failure and its Retry, which gives the
 * user a new task.
 */
export async function dismissOperationByUser(
  executor: DbExecutor,
  target: OperationTarget,
): Promise<OperationRow> {
  return inTransaction(executor, async (trx) => {
    const op = await lockOperation(trx, target);
    if (op.status !== 'needs_user_action') {
      throw new InvalidTransitionError(op.id, op.status, 'failed');
    }
    const failed = await transitionOperation(
      trx,
      op,
      {
        to: 'failed',
        error: {
          code: 'dismissed_by_user',
          message: "You dismissed this step, so it wasn't done. Retry to get a new task.",
        },
      },
      { action: 'dismiss' },
    );
    await dismissOpenTasks(trx, op);
    return failed;
  });
}

export async function lockOperation(
  trx: DbTransaction,
  target: OperationTarget,
): Promise<OperationRow> {
  const op = await trx
    .selectFrom('marketplace_operation')
    .selectAll()
    .where('account_id', '=', target.accountId)
    .where('id', '=', target.operationId)
    .forUpdate()
    .executeTakeFirst();
  if (op === undefined) throw new OperationNotFoundError(target.operationId);
  return op;
}

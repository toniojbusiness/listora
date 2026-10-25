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
import { syncItemListedStatus } from './item-status.ts';
import { removeOperationJob, scheduleOperationJob } from './jobs.ts';
import { createdAfter } from './ordering.ts';
import {
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
 * operation throws `IdempotencyConflictError`.
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
 * Refused when a newer operation exists on the listing, since retrying would undo it.
 */
export async function retryOperation(
  executor: DbExecutor,
  target: OperationTarget,
): Promise<OperationRow> {
  return inTransaction(executor, async (trx) => {
    const op = await lockOperation(trx, target);
    if (op.status !== 'failed') throw new InvalidTransitionError(op.id, op.status, 'queued');
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

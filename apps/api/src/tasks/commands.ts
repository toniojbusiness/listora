/**
 * Finishing a user task. A task an assisted operation waits on finishes only through the
 * operation engine's commands: `confirmOperationByUser` (the only way such an operation can
 * succeed, and only as "you confirmed") and `dismissOperationByUser` (the operation fails, with
 * a Retry, and is never counted as done).
 */
import type { FieldError, UserTaskCompletion } from '@listora/api-contract';
import type { DbTransaction } from '@listora/db';
import { confirmOperationByUser, dismissOperationByUser } from '@listora/operations';

import { writeAudit } from '../audit.ts';
import { isPgError, PG_ERROR } from '../db-errors.ts';
import { ApiError, notFound, validationFailed } from '../errors.ts';
import { engineCommand } from '../operations/routes.ts';
import { identityFromUrl } from '../listings/identity.ts';
import { findListingByIdentity, type ListingIdentity } from '../listings/repository.ts';
import { marketplaceName } from '../listings/views.ts';
import type { Tenant } from '../tenancy.ts';
import { findTask, lockTask, settleTask, type TaskRow } from './repository.ts';

/** The completion properties each kind takes besides `note` (the contract's table). */
const COMPLETION_FIELDS = {
  list_manually: ['externalUrl'],
  delist_manually: [],
  edit_manually: [],
  reconnect: [],
  confirm_sale: ['saleCorrection'],
  review_match: ['matchedItemId', 'matchedListingId', 'rejectMatch'],
  resolve_double_sale: [],
} as const satisfies Record<string, readonly (keyof UserTaskCompletion)[]>;

type KnownKind = keyof typeof COMPLETION_FIELDS;

function isKnownKind(kind: string): kind is KnownKind {
  return Object.hasOwn(COMPLETION_FIELDS, kind);
}

/**
 * The user confirms they did the task. For a list task, the listing's URL (pasted, or shared
 * from the marketplace) links the listing first, so later tasks open the listing itself.
 */
export async function completeUserTask(
  trx: DbTransaction,
  tenant: Tenant,
  taskId: string,
  completion: UserTaskCompletion,
): Promise<TaskRow> {
  const task = await openTask(trx, tenant, taskId);
  if (!isKnownKind(task.kind)) {
    throw new ApiError(
      'invalid_state_transition',
      'This task needs a newer version of Listora. Update the app to finish it.',
    );
  }
  checkCompletionFields(task.kind, completion);
  const linked =
    task.kind === 'list_manually' && completion.externalUrl !== undefined
      ? await linkTaskListing(trx, tenant, task, completion.externalUrl)
      : undefined;

  const operationId = task.operation_id;
  if (operationId !== null) {
    await engineCommand(() =>
      confirmOperationByUser(trx, {
        accountId: tenant.accountId,
        operationId,
        userId: tenant.userId,
      }),
    );
  } else if (task.kind === 'reconnect' || task.kind === 'resolve_double_sale') {
    // The user's word that they reconnected, or canceled the second order.
    await settleTask(trx, tenant, task.id, 'done');
  } else {
    // Sale confirmations and match reviews finish with their own decisions, which land with the
    // features that create those tasks; until then nothing can mark one done.
    throw new ApiError(
      'invalid_state_transition',
      'This task cannot be finished in this version of Listora yet.',
    );
  }

  await writeAudit(trx, tenant, {
    ...(task.item_id === null ? {} : { itemId: task.item_id }),
    action: 'task.completed',
    changes: {
      taskId: task.id,
      kind: task.kind,
      ...(task.marketplace === null ? {} : { marketplace: task.marketplace }),
      ...(linked === undefined ? {} : { url: linked.url }),
      ...(completion.note === undefined ? {} : { note: completion.note }),
    },
  });
  return reread(trx, tenant, task.id);
}

/**
 * The user dismisses the task without doing it. An operation waiting on it fails, so the
 * listing shows the failure and a Retry; it is never counted as done.
 */
export async function dismissUserTask(
  trx: DbTransaction,
  tenant: Tenant,
  taskId: string,
): Promise<TaskRow> {
  const task = await openTask(trx, tenant, taskId);
  const operationId = task.operation_id;
  if (operationId === null) {
    await settleTask(trx, tenant, task.id, 'dismissed');
  } else {
    await engineCommand(() =>
      dismissOperationByUser(trx, {
        accountId: tenant.accountId,
        operationId,
      }),
    );
  }
  await writeAudit(trx, tenant, {
    ...(task.item_id === null ? {} : { itemId: task.item_id }),
    action: 'task.dismissed',
    changes: {
      taskId: task.id,
      kind: task.kind,
      ...(task.marketplace === null ? {} : { marketplace: task.marketplace }),
    },
  });
  return reread(trx, tenant, task.id);
}

/** Locks the task and refuses one that is no longer open. */
async function openTask(trx: DbTransaction, tenant: Tenant, taskId: string): Promise<TaskRow> {
  const locked = await lockTask(trx, tenant, taskId);
  if (!locked) throw notFound('Task');
  if (locked.status !== 'open') {
    throw new ApiError(
      'invalid_state_transition',
      locked.status === 'done' ? 'This task is already done.' : 'This task was dismissed.',
    );
  }
  return reread(trx, tenant, taskId);
}

function checkCompletionFields(kind: KnownKind, completion: UserTaskCompletion): void {
  const allowed = new Set<string>([...COMPLETION_FIELDS[kind], 'note']);
  const extra: FieldError[] = Object.keys(completion)
    .filter((field) => !allowed.has(field))
    .map((field) => ({ field, message: `does not apply to a ${kind} task` }));
  if (extra.length > 0) throw validationFailed(extra);
}

/**
 * Records the listing's URL on the task's listing: its marketplace listing id and canonical
 * URL. The URL must be a single listing on the task's marketplace that no other listing has.
 */
async function linkTaskListing(
  trx: DbTransaction,
  tenant: Tenant,
  task: TaskRow,
  url: string,
): Promise<ListingIdentity> {
  if (task.listing_id === null || task.marketplace === null) {
    throw new Error(`list task ${task.id} has no listing`);
  }
  const name = marketplaceName(task.marketplace);
  const identity = identityFromUrl(url, 'externalUrl');
  if (identity.marketplace !== task.marketplace) {
    throw validationFailed(
      [{ field: 'externalUrl', message: `is not a ${name} listing` }],
      `This is a ${marketplaceName(identity.marketplace)} link. Paste the ${name} listing's link.`,
    );
  }
  const existing = await findListingByIdentity(trx, tenant, identity);
  if (existing && existing.id !== task.listing_id) {
    throw new ApiError(
      'already_exists',
      `This ${name} listing is already linked to ${existing.sku}.`,
    );
  }
  try {
    await trx
      .updateTable('marketplace_listing')
      .set({ external_url: identity.url, external_listing_id: identity.listingId })
      .where('account_id', '=', tenant.accountId)
      .where('id', '=', task.listing_id)
      .execute();
  } catch (error) {
    if (isPgError(error, PG_ERROR.uniqueViolation)) {
      throw new ApiError(
        'already_exists',
        `This ${name} listing was just linked. Reload and check.`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
  return identity;
}

async function reread(trx: DbTransaction, tenant: Tenant, taskId: string): Promise<TaskRow> {
  const row = await findTask(trx, tenant, taskId);
  if (!row) throw new Error(`task ${taskId} vanished inside its own transaction`);
  return row;
}

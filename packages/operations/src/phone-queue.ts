/**
 * Operation steps handed to the phone (docs/features/phone-execution.md). A connection whose
 * automated steps run on the phone (`marketplace_connection.runs_on`) gets each such step as a
 * `phone_work` row instead of a browser runner job. The operation keeps its status and its job:
 * the job only rechecks, every `recheckMs`, that the row is there, that a phone run of it still
 * holds its lease (a run whose lease ran out stopped mid-step and is recovered like any
 * interrupted step), and that it has not waited longer than `maxWaitMs`, after which it fails
 * with a Retry. The phone claims the row through the API, runs the step (executor.ts, with the
 * phone as its host), and the row goes when the step's result is recorded.
 */
import { sql } from 'kysely';

import type { DbExecutor, DbTransaction, Marketplace } from '@listora/db';

import { OPERATION_PRIORITY, scheduleOperationJob } from './jobs.ts';
import type { OperationRow } from './transitions.ts';

export interface PhoneQueueSettings {
  /** How often the worker looks at an operation waiting for the phone (default 15 minutes). */
  recheckMs: number;
  /** How long an operation may wait for the phone before it fails, with a Retry (24 hours). */
  maxWaitMs: number;
}

export const DEFAULT_PHONE_QUEUE: PhoneQueueSettings = {
  recheckMs: 15 * 60_000,
  maxWaitMs: 24 * 3_600_000,
};

/** The error of an operation that waited for the phone too long. */
export const PHONE_UNAVAILABLE_ERROR = 'phone_unavailable';

export interface PhoneWorkState {
  id: string;
  waitingSince: Date;
  /** Until when a phone run of it holds; `null` while it waits. */
  leaseExpiresAt: Date | null;
}

/** The operation's phone work, if it has some, locked. */
export async function phoneWorkOf(
  trx: DbTransaction,
  op: Pick<OperationRow, 'account_id' | 'id'>,
): Promise<PhoneWorkState | undefined> {
  const row = await trx
    .selectFrom('phone_work')
    .select(['id', 'waiting_since', 'lease_expires_at'])
    .where('account_id', '=', op.account_id)
    .where('operation_id', '=', op.id)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : { id: row.id, waitingSince: row.waiting_since, leaseExpiresAt: row.lease_expires_at };
}

/**
 * Hands the operation's next step to the phone: its `phone_work` row, waiting since now unless
 * it already waits. Returns since when it waits.
 */
export async function queueOperationForPhone(
  trx: DbTransaction,
  op: Pick<OperationRow, 'account_id' | 'id'>,
  target: { connectionId: string; marketplace: Marketplace; priority: number },
): Promise<Date> {
  await trx
    .insertInto('phone_work')
    .values({
      account_id: op.account_id,
      connection_id: target.connectionId,
      marketplace: target.marketplace,
      purpose: 'operation',
      operation_id: op.id,
      priority: target.priority,
    })
    .onConflict((conflict) =>
      conflict
        .columns(['account_id', 'operation_id'])
        .where('operation_id', 'is not', null)
        .doUpdateSet({ priority: target.priority }),
    )
    .execute();
  const row = await trx
    .selectFrom('phone_work')
    .select('waiting_since')
    .where('account_id', '=', op.account_id)
    .where('operation_id', '=', op.id)
    .executeTakeFirstOrThrow();
  return row.waiting_since;
}

/** Removes the operation's phone work (its step went elsewhere, or was recorded). */
export async function removePhoneWork(
  executor: DbExecutor,
  op: Pick<OperationRow, 'account_id' | 'id'>,
): Promise<void> {
  await executor
    .deleteFrom('phone_work')
    .where('account_id', '=', op.account_id)
    .where('operation_id', '=', op.id)
    .execute();
}

/** Since when each of the operations waits for the phone, for those that do. */
export async function phoneWaits(
  executor: DbExecutor,
  accountId: string,
  operationIds: readonly string[],
): Promise<Map<string, PhoneWait>> {
  if (operationIds.length === 0) return new Map();
  const rows = await executor
    .selectFrom('phone_work')
    .select([
      'operation_id',
      'waiting_since',
      sql<boolean>`lease_expires_at is not null and lease_expires_at > now()`.as('running'),
    ])
    .where('account_id', '=', accountId)
    .where('operation_id', 'in', [...operationIds])
    .execute();
  return new Map(
    rows.flatMap((row) =>
      row.operation_id === null
        ? []
        : [[row.operation_id, { since: row.waiting_since, running: row.running }]],
    ),
  );
}

/** An operation step handed to the phone, as the status display shows it. */
export interface PhoneWait {
  since: Date;
  /** The phone is running it now. */
  running: boolean;
}

/**
 * The connection's operation steps that wait for the phone and are not being run there go back
 * to the engine now (the connection's steps run in the cloud again), which hands each to the
 * browser runner.
 */
export async function releasePhoneOperations(
  trx: DbTransaction,
  connection: { accountId: string; connectionId: string },
): Promise<number> {
  const released = await trx
    .deleteFrom('phone_work')
    .where('account_id', '=', connection.accountId)
    .where('connection_id', '=', connection.connectionId)
    .where('purpose', '=', 'operation')
    .where((eb) =>
      eb.or([eb('lease_expires_at', 'is', null), eb('lease_expires_at', '<=', sql<Date>`now()`)]),
    )
    .returning('operation_id')
    .execute();
  for (const { operation_id: operationId } of released) {
    if (operationId === null) continue;
    const op = await trx
      .selectFrom('marketplace_operation')
      .select(['account_id', 'id', 'listing_id', 'origin'])
      .where('account_id', '=', connection.accountId)
      .where('id', '=', operationId)
      .executeTakeFirst();
    if (op === undefined) continue;
    await scheduleOperationJob(trx, {
      accountId: op.account_id,
      operationId: op.id,
      listingId: op.listing_id,
      priority: op.origin === 'auto_delist' ? OPERATION_PRIORITY.urgent : OPERATION_PRIORITY.normal,
      runAt: null,
    });
  }
  return released.length;
}

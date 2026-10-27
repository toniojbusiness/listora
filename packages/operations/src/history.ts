import { sql } from 'kysely';

import type { DbExecutor, JsonObject, JsonValue } from '@listora/db';

import type { OperationRow } from './transitions.ts';

/**
 * Whether any step of the operation started under a mode other than assisted (the API, or the
 * browser runner), so its request may have reached the marketplace. A `running` event without a
 * recorded mode counts.
 */
export async function wasSentThroughApi(
  executor: DbExecutor,
  op: Pick<OperationRow, 'account_id' | 'id'>,
): Promise<boolean> {
  const event = await executor
    .selectFrom('operation_event')
    .select('id')
    .where('account_id', '=', op.account_id)
    .where('operation_id', '=', op.id)
    .where('to_status', '=', 'running')
    .where(sql<string | null>`detail->>'mode'`, 'is distinct from', 'assisted')
    .limit(1)
    .executeTakeFirst();
  return event !== undefined;
}

/** Codes of a send whose session never opened: Listora was pacing it, or another run held it. */
const NEVER_OPENED_CODES: readonly string[] = ['automation_paced', 'automation_busy'];

/**
 * Whether an earlier send of the operation may have changed the listing on the marketplace, from
 * the result each send recorded. A send changed nothing for certain when its step says so: it
 * sent nothing (`sent: false`, or the read before it could not run), the marketplace refused it,
 * or it stopped in a way that tells (an automated script that stopped before any step that
 * changes the listing, `excerpt.mutated: false`, or a session that never opened). Every other
 * send may have: a confirmed or unknown result, a temporary failure that can hide an applied
 * change (a 5xx), a task for the user (they may have done it), and a step that never recorded
 * its result (it was interrupted).
 */
export async function mayHaveSentBefore(
  executor: DbExecutor,
  op: Pick<OperationRow, 'account_id' | 'id'>,
): Promise<boolean> {
  const events = await executor
    .selectFrom('operation_event')
    .select(['from_status', 'to_status', 'detail'])
    .where('account_id', '=', op.account_id)
    .where('operation_id', '=', op.id)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  // A send under way: its step started (`running`) and has not recorded its result yet.
  let sending = false;
  for (const event of events) {
    if (sending && event.from_status === 'running') {
      if (!changedNothing(event.detail)) return true;
      sending = false;
    }
    if (event.to_status === 'running') {
      if (sending) return true;
      sending = event.detail['step'] !== 'check';
    }
  }
  return sending;
}

/** Whether a send step's recorded result shows it changed nothing on the marketplace. */
function changedNothing(detail: JsonObject): boolean {
  if (detail['step'] !== 'send') return false;
  // A send to several listings (an end of a pending and a verified id) records each one's.
  const targets = detail['targets'];
  if (Array.isArray(targets)) {
    return targets.every((target) => {
      const each = objectOf(target);
      return each !== undefined && changedNothing(each);
    });
  }
  if (detail['sent'] === false) return true;
  const outcome = objectOf(detail['outcome']);
  if (outcome === undefined) {
    // The read before the send decided nothing (it failed, or must be repeated): nothing was sent.
    return objectOf(detail['precheck']) !== undefined;
  }
  const type = outcome['type'];
  if (type === 'rejected') return true;
  if (type !== 'transient') return false;
  const code = outcome['code'];
  return (
    (typeof code === 'string' && NEVER_OPENED_CODES.includes(code)) ||
    objectOf(detail['excerpt'])?.['mutated'] === false
  );
}

function objectOf(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

/**
 * `Idempotency-Key` handling for POST operations (contract README, "Idempotency").
 *
 * The whole request runs in one transaction that first takes a transaction-scoped advisory
 * lock on (account, key):
 * - another request holding the lock → `409 idempotency_key_in_progress` (retryable);
 * - a stored response for the key → replayed if the request is the same, otherwise
 *   `422 idempotency_key_reused`;
 * - no stored response → the operation runs, and its successful response is stored in the
 *   same transaction as the change. A failure rolls both back, so nothing is stored and a retry
 *   runs again. A crash releases the lock with the transaction, so a key is never stuck.
 *
 * An expired record counts as absent. Each stored response also deletes a batch of expired
 * records (`IDEMPOTENCY_SWEEP_BATCH`), so the table does not grow without bound.
 */
import { createHash } from 'node:crypto';

import { jsonb, type Db, type DbTransaction, type JsonValue } from '@listora/db';
import { sql } from 'kysely';

import { canonicalJson } from './canonical-json.ts';
import { ApiError } from './errors.ts';
import type { Tenant } from './tenancy.ts';

/** How long a stored response is replayed; the contract promises at least 24 hours. */
export const IDEMPOTENCY_RETENTION_HOURS = 24;
/**
 * Expired records each POST deletes, from any account. A POST stores at most one record, so
 * the table never holds much more than a retention period of records.
 */
export const IDEMPOTENCY_SWEEP_BATCH = 100;

export interface IdempotentRequest {
  key: string;
  operationId: string;
  /** Path parameters and body: what makes two requests with the same key the same request. */
  request: { params: unknown; body: unknown };
}

export interface StoredResponse {
  status: number;
  body: JsonValue | undefined;
}

export async function runIdempotent(
  db: Db,
  tenant: Tenant,
  request: IdempotentRequest,
  execute: (trx: DbTransaction) => Promise<StoredResponse>,
): Promise<StoredResponse> {
  const requestHash = hashRequest(request);
  return db.transaction().execute(async (trx) => {
    const lockName = `idempotency:${tenant.accountId}:${request.key}`;
    const { rows } = await sql<{ locked: boolean }>`
      select pg_try_advisory_xact_lock(hashtextextended(${lockName}, 0)) as locked
    `.execute(trx);
    if (rows[0]?.locked !== true) {
      throw new ApiError(
        'idempotency_key_in_progress',
        'This request is still being processed. Try again in a moment.',
        { retryAfterSeconds: 1 },
      );
    }

    const stored = await trx
      .selectFrom('idempotency_record')
      .select(['operation_id', 'request_hash', 'response_status', 'response_body'])
      .select(sql<boolean>`expires_at <= now()`.as('expired'))
      .where('account_id', '=', tenant.accountId)
      .where('key', '=', request.key)
      .executeTakeFirst();
    if (stored?.expired === true) {
      await trx
        .deleteFrom('idempotency_record')
        .where('account_id', '=', tenant.accountId)
        .where('key', '=', request.key)
        .execute();
    } else if (stored) {
      if (stored.operation_id !== request.operationId || stored.request_hash !== requestHash) {
        throw new ApiError(
          'idempotency_key_reused',
          'This Idempotency-Key was already used for a different request. Use a new key.',
        );
      }
      return { status: stored.response_status, body: stored.response_body ?? undefined };
    }

    const response = await execute(trx);
    await trx
      .insertInto('idempotency_record')
      .values({
        account_id: tenant.accountId,
        key: request.key,
        operation_id: request.operationId,
        request_hash: requestHash,
        response_status: response.status,
        response_body: response.body === undefined ? null : jsonb(response.body),
        expires_at: sql<Date>`now() + make_interval(hours => ${IDEMPOTENCY_RETENTION_HOURS})`,
      })
      .execute();
    await sweepExpired(trx);
    return response;
  });
}

/**
 * Deletes a batch of expired records, oldest first. Rows another transaction holds are
 * skipped, so concurrent POSTs never wait on each other here.
 */
async function sweepExpired(trx: DbTransaction): Promise<void> {
  await sql`
    delete from idempotency_record
    where (account_id, key) in (
      select account_id, key from idempotency_record
      where expires_at <= now()
      order by expires_at
      limit ${IDEMPOTENCY_SWEEP_BATCH}
      for update skip locked
    )
  `.execute(trx);
}

/** sha256 over the operation and a canonical (key-sorted) JSON form of the request. */
export function hashRequest(request: IdempotentRequest): string {
  return createHash('sha256')
    .update(canonicalJson({ operationId: request.operationId, ...request.request }))
    .digest('hex');
}

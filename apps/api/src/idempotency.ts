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
 */
import { createHash } from 'node:crypto';

import { jsonb, type Db, type DbTransaction, type JsonValue } from '@listora/db';
import { sql } from 'kysely';

import { ApiError } from './errors.ts';
import type { Tenant } from './tenancy.ts';

/** How long a stored response is replayed; the contract promises at least 24 hours. */
export const IDEMPOTENCY_RETENTION_HOURS = 24;

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
    return response;
  });
}

/** sha256 over the operation and a canonical (key-sorted) JSON form of the request. */
export function hashRequest(request: IdempotentRequest): string {
  return createHash('sha256')
    .update(canonicalJson({ operationId: request.operationId, ...request.request }))
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

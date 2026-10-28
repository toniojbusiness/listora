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
 *
 * A record holds neither the key nor a readable response: it is found by the key's SHA-256, and
 * the response is sealed (AES-256-GCM) under a key derived from the Idempotency-Key itself,
 * which only the client holds. So the table, its backups, and anyone reading them learn nothing
 * a response carried, such as a new invite's code (docs/features/invites.md).
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

import type { Db, DbTransaction, JsonValue } from '@listora/db';
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

    const digest = keyDigest(request.key);
    // A record stored before responses were sealed is under the key itself (for a day at most).
    const keys = [digest, request.key];
    const stored = await trx
      .selectFrom('idempotency_record')
      .select([
        'operation_id',
        'request_hash',
        'response_status',
        'response_body',
        'response_ciphertext',
      ])
      .select(sql<boolean>`expires_at <= now()`.as('expired'))
      .where('account_id', '=', tenant.accountId)
      .where('key', 'in', keys)
      .executeTakeFirst();
    if (stored?.expired === true) {
      await trx
        .deleteFrom('idempotency_record')
        .where('account_id', '=', tenant.accountId)
        .where('key', 'in', keys)
        .execute();
    } else if (stored) {
      if (stored.operation_id !== request.operationId || stored.request_hash !== requestHash) {
        throw new ApiError(
          'idempotency_key_reused',
          'This Idempotency-Key was already used for a different request. Use a new key.',
        );
      }
      const body =
        stored.response_ciphertext === null
          ? stored.response_body
          : openResponse(stored.response_ciphertext, request.key, tenant.accountId);
      return { status: stored.response_status, body: body ?? undefined };
    }

    const response = await execute(trx);
    await trx
      .insertInto('idempotency_record')
      .values({
        account_id: tenant.accountId,
        key: digest,
        operation_id: request.operationId,
        request_hash: requestHash,
        response_status: response.status,
        response_body: null,
        response_ciphertext: sealResponse(response.body ?? null, request.key, tenant.accountId),
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

/** What a record is found by: the Idempotency-Key's SHA-256, never the key. */
export function keyDigest(key: string): string {
  return createHash('sha256').update(`listora-idempotency-key\n${key}`).digest('hex');
}

const SEAL_INFO = 'listora idempotency response v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The response's key: derived from the Idempotency-Key, bound to the account. */
function responseKey(key: string, accountId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', key, accountId, SEAL_INFO, 32));
}

/** The response as JSON, sealed: the IV, the ciphertext, then the tag. */
export function sealResponse(body: JsonValue, key: string, accountId: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', responseKey(key, accountId), iv);
  const sealed = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, sealed, cipher.getAuthTag()]);
}

/** The sealed response; throws when it was sealed under another key or changed. */
export function openResponse(ciphertext: Buffer, key: string, accountId: string): JsonValue {
  const iv = ciphertext.subarray(0, IV_BYTES);
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', responseKey(key, accountId), iv);
  decipher.setAuthTag(tag);
  const json = Buffer.concat([
    decipher.update(ciphertext.subarray(IV_BYTES, ciphertext.length - TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(json) as JsonValue;
}

/** sha256 over the operation and a canonical (key-sorted) JSON form of the request. */
export function hashRequest(request: IdempotentRequest): string {
  return createHash('sha256')
    .update(canonicalJson({ operationId: request.operationId, ...request.request }))
    .digest('hex');
}

/**
 * Data retention (docs/features/privacy.md): how long Listora keeps logs, raw payloads,
 * buyers' details, and other records that only matter for a while, and the daily job
 * (`data_retention`) that deletes or clears what expired. Each rule deletes in batches, oldest first, and a run stops after
 * `maxBatches` per rule, so a backlog (after downtime, or the first run) is worked off over a
 * few days without one long transaction.
 *
 * Kept elsewhere, by the code that writes them: automation screenshots (14 days) and run records
 * (90 days, the automation dispatcher), package photos (60 days after the sale shipped, the
 * `pack_photos` job in @listora/pack-check), idempotency records (24 hours, later POSTs), raw
 * sale emails that could not be processed (14 days, a storage lifecycle rule), and deleted
 * identities (48 hours, later deletions).
 */
import { startConnectionDeletion } from '@listora/connections';
import { inTransaction, type Db, type DbTransaction } from '@listora/db';
import { NAMED_LISTING_KEY, SETTLED_STATUSES } from '@listora/operations';
import type { Logger } from '@listora/shared';
import { sql } from 'kysely';

/** The daily retention job. */
export const DATA_RETENTION_TASK = 'data_retention';
/** 04:23 UTC every day, off the hour and after the night's sale checks. */
export const DATA_RETENTION_SCHEDULE = '23 4 * * *';

const DAY_MS = 86_400_000;

/** How many days each kind of record is kept. */
export const RETENTION_DAYS = {
  /**
   * An operation's step-by-step history (redacted request and response excerpts), once the
   * operation settled. The operation row keeps its final status, evidence, and error, and
   * events that recorded a listing id the engine named are kept, so a name is never reused.
   */
  operationEvents: 180,
  /** Raw marketplace notifications, poll results, and parsed emails, after processing. */
  inboundEvents: 90,
  /**
   * Sale-check records (docs/features/activity.md): when each check ran, what it read, and why
   * it failed, after the check started. A sale keeps its own detection source.
   */
  saleCheckRuns: 90,
  /** AI usage events (cost and quota accounting); the daily totals stay with the account. */
  aiUsageEvents: 400,
  /** A connection whose access the marketplace revoked, unless the seller reconnects. */
  revokedConnections: 30,
  /** Connect attempts, after their expiry. */
  connectionAuthorizations: 1,
  /** Deletion completion records (no personal data). */
  deletionRecords: 730,
  /**
   * The buyer's details on a sale's label (their first name, the tracking number), after the sale
   * is done: shipped, canceled, or returned, from the latest of those. Past the marketplaces'
   * claim windows, like its package photo (`PACK_PHOTO_RETENTION_DAYS` in @listora/pack-check).
   */
  saleLabelBuyers: 60,
  /** A packed sale's tracking number, as long as its label's; the package record stays. */
  packageTracking: 60,
  /** The buyer's name on an offer, once it stopped waiting on the seller (`closed_at`). */
  offerBuyers: 60,
} as const;

export type RetentionRule = keyof typeof RETENTION_DAYS;

export interface DataRetentionOptions {
  db: Db;
  logger: Logger;
  /** Rows per batch (default 1000). */
  batchSize?: number;
  /** Batches per rule and run (default 50). */
  maxBatches?: number;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: () => number;
}

/** Rows each rule deleted (for revoked connections: connections deleted). */
export type DataRetentionSummary = Record<RetentionRule, number>;

/** One run of the retention job: every rule, in order. Throws when the database fails. */
export async function runDataRetention(
  options: DataRetentionOptions,
): Promise<DataRetentionSummary> {
  const now = options.now ?? Date.now;
  const batchSize = options.batchSize ?? 1000;
  const maxBatches = options.maxBatches ?? 50;
  const cutoff = (rule: RetentionRule): Date => new Date(now() - RETENTION_DAYS[rule] * DAY_MS);
  const repeat = async (batch: () => Promise<number>): Promise<number> => {
    let total = 0;
    for (let round = 0; round < maxBatches; round += 1) {
      const deleted = await batch();
      total += deleted;
      if (deleted < batchSize) break;
    }
    return total;
  };
  const { db } = options;

  const summary: DataRetentionSummary = {
    operationEvents: await repeat(() =>
      inTransaction(db, (trx) => deleteOperationEvents(trx, cutoff('operationEvents'), batchSize)),
    ),
    inboundEvents: await repeat(async () => {
      const result = await sql`
        delete from inbound_event where id in (
          select id from inbound_event
          where processed_at < ${cutoff('inboundEvents')}
          order by processed_at
          limit ${batchSize}
        )
      `.execute(db);
      return Number(result.numAffectedRows ?? 0);
    }),
    saleCheckRuns: await repeat(async () => {
      const result = await sql`
        delete from sale_check_run where id in (
          select id from sale_check_run
          where started_at < ${cutoff('saleCheckRuns')}
          order by started_at
          limit ${batchSize}
        )
      `.execute(db);
      return Number(result.numAffectedRows ?? 0);
    }),
    aiUsageEvents: await repeat(() =>
      inTransaction(db, async (trx) => {
        await allowRetentionDelete(trx, 'ai_usage_event');
        const result = await sql`
          delete from ai_usage_event where id in (
            select id from ai_usage_event
            where created_at < ${cutoff('aiUsageEvents')}
            order by created_at
            limit ${batchSize}
          )
        `.execute(trx);
        return Number(result.numAffectedRows ?? 0);
      }),
    ),
    revokedConnections: await repeat(() =>
      deleteRevokedConnections(db, cutoff('revokedConnections'), batchSize),
    ),
    connectionAuthorizations: await repeat(async () => {
      const result = await sql`
        delete from connection_authorization where id in (
          select id from connection_authorization
          where expires_at < ${cutoff('connectionAuthorizations')}
          order by expires_at
          limit ${batchSize}
        )
      `.execute(db);
      return Number(result.numAffectedRows ?? 0);
    }),
    deletionRecords: await repeat(async () => {
      const result = await sql`
        delete from deletion_record where id in (
          select id from deletion_record
          where completed_at < ${cutoff('deletionRecords')}
          order by completed_at
          limit ${batchSize}
        )
      `.execute(db);
      return Number(result.numAffectedRows ?? 0);
    }),
    saleLabelBuyers: await repeat(async () => {
      const result = await sql`
        update sale_label as label
        set buyer_first_name = null, tracking_number = null, carrier = null, source = null
        where (label.account_id, label.sale_id) in (
          select label.account_id, label.sale_id from sale_label as label
          join sale on sale.account_id = label.account_id and sale.id = label.sale_id
          where ${saleDone(cutoff('saleLabelBuyers'))}
            and (label.buyer_first_name is not null or label.tracking_number is not null)
          order by label.sale_id
          limit ${batchSize}
        )
      `.execute(db);
      return Number(result.numAffectedRows ?? 0);
    }),
    packageTracking: await repeat(async () => {
      const result = await sql`
        update sale_pack as pack
        set tracking_number = null
        where (pack.account_id, pack.sale_id) in (
          select pack.account_id, pack.sale_id from sale_pack as pack
          join sale on sale.account_id = pack.account_id and sale.id = pack.sale_id
          where ${saleDone(cutoff('packageTracking'))} and pack.tracking_number is not null
          order by pack.sale_id
          limit ${batchSize}
        )
      `.execute(db);
      return Number(result.numAffectedRows ?? 0);
    }),
    offerBuyers: await repeat(async () => {
      const result = await sql`
        update marketplace_offer set buyer_name = null
        where id in (
          select id from marketplace_offer
          where status <> 'pending' and closed_at < ${cutoff('offerBuyers')}
            and buyer_name is not null
          order by closed_at
          limit ${batchSize}
        )
      `.execute(db);
      return Number(result.numAffectedRows ?? 0);
    }),
  };
  options.logger.info({ task: DATA_RETENTION_TASK, deleted: summary }, 'data retention ran');
  return summary;
}

/**
 * The query's `sale` is done (shipped, canceled, or returned) since before `cutoff`, counted from
 * the latest of those: a return after shipping starts the count again.
 */
function saleDone(cutoff: Date) {
  return sql<boolean>`sale.status in ('shipped', 'canceled', 'returned')
    and greatest(sale.shipped_at, sale.canceled_at, sale.returned_at) < ${cutoff}`;
}

/**
 * Lets this transaction delete rows of one append-only table: its trigger rejects every other
 * direct delete (migration `20261025221245_privacy_retention`).
 */
async function allowRetentionDelete(
  trx: DbTransaction,
  table: 'operation_event' | 'ai_usage_event',
): Promise<void> {
  await sql`select set_config('listora.retention_delete', ${table}, true)`.execute(trx);
}

async function deleteOperationEvents(
  trx: DbTransaction,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  await allowRetentionDelete(trx, 'operation_event');
  const result = await sql`
    delete from operation_event where id in (
      select event.id from operation_event as event
      join marketplace_operation as operation
        on operation.account_id = event.account_id and operation.id = event.operation_id
      where event.created_at < ${cutoff}
        and operation.status = any(${[...SETTLED_STATUSES]}::text[])
        and operation.updated_at < ${cutoff}
        and not event.detail ? ${NAMED_LISTING_KEY}
      order by event.created_at
      limit ${batchSize}
    )
  `.execute(trx);
  return Number(result.numAffectedRows ?? 0);
}

/**
 * Connections whose access the marketplace revoked more than the retention period ago, and that
 * the seller has not reconnected: their data is deleted as if the seller had unlinked them.
 * Revocation already deleted their tokens.
 */
async function deleteRevokedConnections(db: Db, cutoff: Date, batchSize: number): Promise<number> {
  const revoked = await db
    .selectFrom('marketplace_connection')
    .select(['account_id', 'id'])
    .where('status', '=', 'revoked')
    .where('last_error_at', '<', cutoff)
    .orderBy('last_error_at')
    .limit(batchSize)
    .execute();
  let deleted = 0;
  for (const connection of revoked) {
    const started = await inTransaction(db, async (trx) => {
      // Reconnected (or deleted) since it was read: leave it.
      const still = await trx
        .selectFrom('marketplace_connection')
        .select('id')
        .where('account_id', '=', connection.account_id)
        .where('id', '=', connection.id)
        .where('status', '=', 'revoked')
        .where('last_error_at', '<', cutoff)
        .forUpdate()
        .executeTakeFirst();
      if (still === undefined) return undefined;
      return startConnectionDeletion(trx, {
        accountId: connection.account_id,
        connectionId: connection.id,
        reason: 'revoked',
      });
    });
    if (started !== undefined) deleted += 1;
  }
  return deleted;
}

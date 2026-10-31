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
   * is done: shipped, canceled, or returned, from the latest of those on the marketplace (a sale
   * already done when Listora recorded it, from its ship-by date or sale time: `saleDone`). Past
   * the marketplaces' claim windows, like its package photo (`PACK_PHOTO_RETENTION_DAYS` in
   * @listora/pack-check).
   */
  saleLabelBuyers: 60,
  /** A packed sale's tracking number, as long as its label's; the package record stays. */
  packageTracking: 60,
  /** The buyer's name on an offer, once it stopped waiting on the seller (`closed_at`). */
  offerBuyers: 60,
  /**
   * A thrift scan the seller never kept (docs/features/thrift-scan.md), after it was made. Its
   * run keeps the counts; a kept scan stays with its item.
   */
  unkeptScans: 90,
  /**
   * The thrift scan's cached web research, past the longest it is used again (an item's facts,
   * 30 days; a brand's, 7).
   */
  scanResearch: 30,
  /**
   * The thrift scan's marketplace comparison reads (numbers only), past the longest they count:
   * a day's budget, a day's pause after a check, and the 24-hour cache.
   */
  marketComparisons: 7,
} as const;

export type RetentionRule = keyof typeof RETENTION_DAYS;

/** The rules that clear buyers' details, which run only when buyer data retention is on. */
export type BuyerDataRule = 'saleLabelBuyers' | 'packageTracking' | 'offerBuyers';

/** `BUYER_DATA_RETENTION`: `off` (the default) clears nothing of buyers; `on` clears. */
export const BUYER_DATA_RETENTIONS = ['off', 'on'] as const;
export type BuyerDataRetention = (typeof BUYER_DATA_RETENTIONS)[number];

export class RetentionConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid retention configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'RetentionConfigError';
    this.issues = issues;
  }
}

/**
 * Reads `BUYER_DATA_RETENTION` (see `.env.example`) once at startup; unset or empty means `off`.
 * Clearing buyers' details is permanent, so only an explicit `on` turns it on.
 */
export function loadBuyerDataRetention(env: NodeJS.ProcessEnv = process.env): BuyerDataRetention {
  const raw = env['BUYER_DATA_RETENTION'];
  const value = raw === undefined || raw === '' ? 'off' : raw;
  const known = BUYER_DATA_RETENTIONS.find((candidate) => candidate === value);
  if (known === undefined) {
    throw new RetentionConfigError([
      `BUYER_DATA_RETENTION must be one of ${BUYER_DATA_RETENTIONS.join(', ')}`,
    ]);
  }
  return known;
}

export interface DataRetentionOptions {
  db: Db;
  logger: Logger;
  /** Rows per batch (default 1000). */
  batchSize?: number;
  /** Batches per rule and run (default 50). */
  maxBatches?: number;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: () => number;
  /**
   * Whether the buyer data rules clear anything (`BUYER_DATA_RETENTION`, default `off`): while
   * off they clear nothing and the run logs, and returns, what they would clear.
   */
  buyerData?: BuyerDataRetention;
}

/**
 * Rows each rule deleted or cleared (for revoked connections: connections deleted); while buyer
 * data retention is off, also what its rules would clear.
 */
export type DataRetentionSummary = Record<RetentionRule, number> & {
  buyerDataWouldClear?: Record<BuyerDataRule, number>;
};

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
  const buyerData = options.buyerData ?? 'off';

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
    unkeptScans: await repeat(async () => {
      const result = await sql`
        delete from item_scan where id in (
          select id from item_scan
          where decision <> 'kept' and created_at < ${cutoff('unkeptScans')}
          order by created_at
          limit ${batchSize}
        )
      `.execute(db);
      return Number(result.numAffectedRows ?? 0);
    }),
    scanResearch: await repeat(async () => {
      const result = await sql`
        delete from scan_research where (account_id, kind, key) in (
          select account_id, kind, key from scan_research
          where created_at < ${cutoff('scanResearch')}
          order by created_at
          limit ${batchSize}
        )
      `.execute(db);
      return Number(result.numAffectedRows ?? 0);
    }),
    marketComparisons: await repeat(async () => {
      const result = await sql`
        delete from market_comparison where id in (
          select id from market_comparison
          where created_at < ${cutoff('marketComparisons')}
          order by created_at
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
    ...(buyerData === 'on'
      ? {
          saleLabelBuyers: await repeat(() =>
            clearBuyerData(db, 'saleLabelBuyers', cutoff, batchSize),
          ),
          packageTracking: await repeat(() =>
            clearBuyerData(db, 'packageTracking', cutoff, batchSize),
          ),
          offerBuyers: await repeat(() => clearBuyerData(db, 'offerBuyers', cutoff, batchSize)),
        }
      : { saleLabelBuyers: 0, packageTracking: 0, offerBuyers: 0 }),
  };
  options.logger.info({ task: DATA_RETENTION_TASK, deleted: summary }, 'data retention ran');
  if (buyerData === 'off') {
    // Nothing of buyers is cleared until the owner turns it on; the log says what would be.
    const wouldClear: Record<BuyerDataRule, number> = {
      saleLabelBuyers: await countBuyerData(db, 'saleLabelBuyers', cutoff),
      packageTracking: await countBuyerData(db, 'packageTracking', cutoff),
      offerBuyers: await countBuyerData(db, 'offerBuyers', cutoff),
    };
    options.logger.info(
      { task: DATA_RETENTION_TASK, buyerDataRetention: 'off', wouldClear },
      'buyer data retention is off: nothing of buyers was cleared',
    );
    return { ...summary, buyerDataWouldClear: wouldClear };
  }
  return summary;
}

/**
 * The buyer data rules' rows: what each clears, and how they are found. Clearing them is
 * permanent, so it runs only with `BUYER_DATA_RETENTION=on`.
 */
const BUYER_DATA_SQL = {
  saleLabelBuyers: {
    // The label's file and Listora's last print of it go with the label.
    set: sql`buyer_first_name = null, tracking_number = null, carrier = null, source = null, label_file_url = null, printed_tracking_number = null, printed_at = null`,
    table: sql`sale_label`,
    rows: (cutoff: Date) => sql`
      select label.account_id, label.sale_id from sale_label as label
      join sale on sale.account_id = label.account_id and sale.id = label.sale_id
      where ${saleDone(cutoff)}
        and (label.buyer_first_name is not null or label.tracking_number is not null)
      order by label.sale_id`,
  },
  packageTracking: {
    set: sql`tracking_number = null`,
    table: sql`sale_pack`,
    rows: (cutoff: Date) => sql`
      select pack.account_id, pack.sale_id from sale_pack as pack
      join sale on sale.account_id = pack.account_id and sale.id = pack.sale_id
      where ${saleDone(cutoff)} and pack.tracking_number is not null
      order by pack.sale_id`,
  },
  offerBuyers: {
    set: sql`buyer_name = null`,
    table: sql`marketplace_offer`,
    rows: (cutoff: Date) => sql`
      select account_id, id from marketplace_offer
      where status <> 'pending' and closed_at < ${cutoff} and buyer_name is not null
      order by closed_at`,
  },
} as const;

/** The row key each buyer data table's rows are found by. */
const BUYER_DATA_KEYS = {
  saleLabelBuyers: sql`(account_id, sale_id)`,
  packageTracking: sql`(account_id, sale_id)`,
  offerBuyers: sql`(account_id, id)`,
} as const;

/** Clears one batch of a buyer data rule's rows; the number cleared. */
async function clearBuyerData(
  db: Db,
  rule: BuyerDataRule,
  cutoff: (rule: RetentionRule) => Date,
  batchSize: number,
): Promise<number> {
  const { set, table, rows } = BUYER_DATA_SQL[rule];
  const result = await sql`
    update ${table} set ${set}
    where ${BUYER_DATA_KEYS[rule]} in (${rows(cutoff(rule))} limit ${batchSize})
  `.execute(db);
  return Number(result.numAffectedRows ?? 0);
}

/** How many rows a buyer data rule would clear now. */
async function countBuyerData(
  db: Db,
  rule: BuyerDataRule,
  cutoff: (rule: RetentionRule) => Date,
): Promise<number> {
  const { rows } = await sql<{ count: string }>`
    select count(*) as count from (${BUYER_DATA_SQL[rule].rows(cutoff(rule))}) as due
  `.execute(db);
  return Number(rows[0]?.count ?? 0);
}

/**
 * The query's `sale` is done (shipped, canceled, or returned) since before `cutoff`, counted from
 * when it was done on the marketplace: the latest of those (a return after shipping starts the
 * count again), as Listora recorded it when it saw the change.
 *
 * A sale the marketplace already showed done when Listora first recorded it (most of a sales
 * history import) was marked done in the transaction that recorded it, so its done time is its
 * `created_at` exactly (both `now()`), and that is only when Listora found it: it was done on the
 * marketplace before then, and the marketplaces' pages name no date it shipped, was canceled, or
 * was returned. Its count starts at the order's last date the marketplace does name, its ship-by
 * date or else its sale time, and never later than the recording.
 */
function saleDone(cutoff: Date) {
  return sql<boolean>`sale.status in ('shipped', 'canceled', 'returned')
    and (case
      when greatest(sale.shipped_at, sale.canceled_at, sale.returned_at) = sale.created_at
        then least(greatest(sale.sold_at, sale.ship_by), sale.created_at)
      else greatest(sale.shipped_at, sale.canceled_at, sale.returned_at)
    end) < ${cutoff}`;
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

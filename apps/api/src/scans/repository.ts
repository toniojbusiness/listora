/**
 * Item scans (docs/features/thrift-scan.md): one row per item scanned at the store, with the
 * AI's read and the call. Every function takes the request's `Tenant` and filters on its
 * account.
 */
import type { ScanCall, ScanOwnSales, ScanRetail, ScanTrend } from '@listora/api-contract';
import {
  jsonb,
  type DbExecutor,
  type ItemScanTable,
  type JsonObject,
  type ScanResearchKind,
} from '@listora/db';
import type { ScanResearch, ThriftScan } from '@listora/analysis';
import type { Selectable } from 'kysely';

import type { Tenant } from '../tenancy.ts';
import type { StoredComparison } from './comparisons.ts';

export type ItemScanRow = Selectable<ItemScanTable>;

/** What `item_scan.call_detail` holds: the call and the own-sales lines, as the app saw them. */
export interface ScanCallDetail {
  readonly call: ScanCall;
  readonly ownSales: readonly ScanOwnSales[];
  readonly trend?: ScanTrend;
  readonly retail?: ScanRetail;
  /** Each marketplace's comparisons (comparisons.ts); absent where none are on. */
  readonly comparisons?: readonly StoredComparison[];
  /** The household's own sales like it in the last 90 days, which the demand weighs. */
  readonly recentOwnSales?: number;
}

/** What `item_scan.research` holds: the web research the app asked for, and where it came from. */
export interface StoredResearch {
  readonly status: 'found' | 'not_found' | 'no_brand';
  readonly research?: ScanResearch;
  readonly cached: boolean;
}

export interface NewItemScan {
  readonly runId: string;
  readonly imageSha256: string;
  readonly imageCount: number;
  readonly read: ThriftScan;
  readonly detail: ScanCallDetail;
  readonly model: string;
  readonly attempts: number;
  readonly costMicros: number;
  readonly readMs: number;
}

export async function insertScan(
  db: DbExecutor,
  tenant: Tenant,
  scan: NewItemScan,
): Promise<ItemScanRow> {
  const { call } = scan.detail;
  return db
    .insertInto('item_scan')
    .values({
      account_id: tenant.accountId,
      run_id: scan.runId,
      created_by_user_id: tenant.userId,
      image_sha256: scan.imageSha256,
      image_count: scan.imageCount,
      read: jsonb(scan.read as unknown as JsonObject),
      call: call.call,
      confidence: call.confidence,
      basis: call.basis,
      call_detail: jsonb(scan.detail as unknown as JsonObject),
      model: scan.model,
      ai_attempts: scan.attempts,
      cost_micros: scan.costMicros,
      read_ms: scan.readMs,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function findScan(
  db: DbExecutor,
  tenant: Tenant,
  scanId: string,
): Promise<ItemScanRow | undefined> {
  return db
    .selectFrom('item_scan')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', scanId)
    .executeTakeFirst();
}

/** The scan, locked for the rest of the transaction. */
export async function lockScan(
  db: DbExecutor,
  tenant: Tenant,
  scanId: string,
): Promise<ItemScanRow | undefined> {
  return db
    .selectFrom('item_scan')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', scanId)
    .forUpdate()
    .executeTakeFirst();
}

/** These scans, locked in id order for the rest of the transaction, by id. */
export async function lockScans(
  db: DbExecutor,
  tenant: Tenant,
  scanIds: readonly string[],
): Promise<Map<string, ItemScanRow>> {
  if (scanIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('item_scan')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('id', 'in', scanIds)
    .orderBy('id')
    .forUpdate()
    .execute();
  return new Map(rows.map((row) => [row.id, row]));
}

/** The run's kept scans whose item is still in Listora, in the order they were scanned. */
export async function keptScans(
  db: DbExecutor,
  tenant: Tenant,
  runId: string,
): Promise<(ItemScanRow & { item_id: string })[]> {
  const rows = await db
    .selectFrom('item_scan')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('run_id', '=', runId)
    .where('decision', '=', 'kept')
    .where('item_id', 'is not', null)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.flatMap((row) => (row.item_id === null ? [] : [{ ...row, item_id: row.item_id }]));
}

/** A scan the seller has not decided on is replaced by a later scan of the same item. */
export async function markReplaced(db: DbExecutor, tenant: Tenant, scanId: string): Promise<void> {
  await db
    .updateTable('item_scan')
    .set({ decision: 'replaced' })
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', scanId)
    .where('decision', '=', 'undecided')
    .execute();
}

export async function markKept(
  db: DbExecutor,
  tenant: Tenant,
  scanId: string,
  itemId: string,
): Promise<ItemScanRow> {
  return db
    .updateTable('item_scan')
    .set({ decision: 'kept', item_id: itemId })
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', scanId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** The account's scans since `since`, for the daily limit. */
export async function scansSince(db: DbExecutor, tenant: Tenant, since: Date): Promise<number> {
  const row = await db
    .selectFrom('item_scan')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('account_id', '=', tenant.accountId)
    .where('created_at', '>=', since)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** The scan with its web research and the call made again with it. */
export async function saveResearch(
  db: DbExecutor,
  tenant: Tenant,
  scanId: string,
  research: StoredResearch,
  detail: ScanCallDetail,
  researchMs: number,
): Promise<ItemScanRow> {
  const { call } = detail;
  return db
    .updateTable('item_scan')
    .set({
      research: jsonb(research as unknown as JsonObject),
      research_ms: researchMs,
      call: call.call,
      confidence: call.confidence,
      basis: call.basis,
      call_detail: jsonb(detail as unknown as JsonObject),
    })
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', scanId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Web facts of one kind kept since `since`, as stored. */
export async function cachedResearch(
  db: DbExecutor,
  tenant: Tenant,
  kind: ScanResearchKind,
  key: string,
  since: Date,
): Promise<JsonObject | undefined> {
  const row = await db
    .selectFrom('scan_research')
    .select('research')
    .where('account_id', '=', tenant.accountId)
    .where('kind', '=', kind)
    .where('key', '=', key)
    .where('created_at', '>=', since)
    .executeTakeFirst();
  return row?.research;
}

export async function cacheResearch(
  db: DbExecutor,
  tenant: Tenant,
  entry: {
    kind: ScanResearchKind;
    key: string;
    research: JsonObject;
    model: string;
    costMicros: number;
  },
): Promise<void> {
  const values = {
    research: jsonb(entry.research),
    model: entry.model,
    cost_micros: entry.costMicros,
    created_at: new Date(),
  };
  await db
    .insertInto('scan_research')
    .values({ account_id: tenant.accountId, kind: entry.kind, key: entry.key, ...values })
    .onConflict((conflict) => conflict.columns(['account_id', 'kind', 'key']).doUpdateSet(values))
    .execute();
}

/** The scan's call made again (with its comparisons), as the app shows it from now on. */
export async function saveDetail(
  db: DbExecutor,
  tenant: Tenant,
  scanId: string,
  detail: ScanCallDetail,
): Promise<ItemScanRow> {
  const { call } = detail;
  return db
    .updateTable('item_scan')
    .set({
      call: call.call,
      confidence: call.confidence,
      basis: call.basis,
      call_detail: jsonb(detail as unknown as JsonObject),
    })
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', scanId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

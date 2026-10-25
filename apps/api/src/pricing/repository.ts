/**
 * Pricing queries: `pricing_snapshot` rows (source-labeled price data), the estimate of the
 * item's current analysis, and the account's actual fees on recent sales. Every function takes
 * the request's `Tenant` and filters on its account.
 */
import {
  jsonb,
  type DbExecutor,
  type InventoryItem,
  type JsonObject,
  type Marketplace,
  type PricingSource,
} from '@listora/db';
import {
  aiEstimatePayloadSchema,
  isRealSoldDataSource,
  soldDataPayloadSchemaFor,
  type AiEstimatePayload,
  type AiEstimateSnapshot,
  type ObservedFee,
  type ObservedSale,
  type SoldDataPayload,
  type SoldDataSnapshot,
} from '@listora/pricing';
import { STANDING_SALE_STATUSES } from '@listora/sales';
import { sql } from 'kysely';
import { z } from 'zod';

import type { Tenant } from '../tenancy.ts';

/** Only this many of a marketplace's most recent sales calibrate its fee estimate. */
export const FEE_CALIBRATION_SALES = 50;
/** Sales older than this say little about today's fees. */
export const FEE_CALIBRATION_WINDOW_DAYS = 365;

export type NewPricingSnapshot =
  | {
      source: 'ai_estimate';
      payload: AiEstimatePayload;
      fetchedAt?: Date;
      expiresAt?: Date;
    }
  | {
      source: Exclude<PricingSource, 'ai_estimate'>;
      payload: SoldDataPayload;
      fetchedAt?: Date;
      expiresAt?: Date;
    };

/**
 * Writes one snapshot for an item of the tenant's account, after checking its payload against
 * its source's schema: the source is the label, so a payload can never be stored under a
 * source it does not belong to, and a source bound to one listing context must name it.
 * Throws a ZodError for an invalid payload.
 */
export async function insertPricingSnapshot(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
  snapshot: NewPricingSnapshot,
): Promise<string> {
  const payload =
    snapshot.source === 'ai_estimate'
      ? aiEstimatePayloadSchema.parse(snapshot.payload)
      : soldDataPayloadSchemaFor(snapshot.source).parse(snapshot.payload);
  const row = await db
    .insertInto('pricing_snapshot')
    .values({
      account_id: tenant.accountId,
      item_id: itemId,
      source: snapshot.source,
      payload: jsonb(payload as JsonObject),
      ...(snapshot.fetchedAt === undefined ? {} : { fetched_at: snapshot.fetchedAt }),
      expires_at: snapshot.expiresAt ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** The estimate written by an analysis's output (`AnalysisResult.priceEstimate`). */
const analysisEstimateSchema = z.object({
  priceEstimate: z.object({
    low: z.unknown(),
    mid: z.unknown(),
    high: z.unknown(),
    confidence: z.unknown(),
  }),
});

export type AnalysisEstimate =
  | { status: 'none' }
  | { status: 'invalid'; analysisId: string }
  | { status: 'found'; payload: AiEstimatePayload };

/**
 * The price estimate of the item's current analysis: the accepted one, or else its latest
 * succeeded analysis. An estimate from any older analysis is out of date and never shown.
 */
export async function currentAnalysisEstimate(
  db: DbExecutor,
  tenant: Tenant,
  item: InventoryItem,
): Promise<AnalysisEstimate> {
  const analysis = await db
    .selectFrom('ai_analysis')
    .select(['id', 'output'])
    .where('account_id', '=', tenant.accountId)
    .where('item_id', '=', item.id)
    .where('status', '=', 'succeeded')
    .orderBy(sql<boolean>`id = ${item.accepted_analysis_id}`, (order) => order.desc().nullsLast())
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!analysis) return { status: 'none' };
  const output = analysisEstimateSchema.safeParse(analysis.output);
  if (!output.success) return { status: 'none' };
  const payload = aiEstimatePayloadSchema.safeParse({
    analysisId: analysis.id,
    ...output.data.priceEstimate,
  });
  return payload.success
    ? { status: 'found', payload: payload.data }
    : { status: 'invalid', analysisId: analysis.id };
}

/**
 * Records an analysis's estimate as an `ai_estimate` snapshot once; later calls for the same
 * analysis keep the first. Concurrent first calls can each insert one, which is harmless:
 * readers take the latest snapshot of the analysis.
 */
export async function recordAiEstimate(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
  payload: AiEstimatePayload,
): Promise<void> {
  const existing = await db
    .selectFrom('pricing_snapshot')
    .select('id')
    .where('account_id', '=', tenant.accountId)
    .where('item_id', '=', itemId)
    .where('source', '=', 'ai_estimate')
    .where(sql<string>`payload->>'analysisId'`, '=', payload.analysisId)
    .executeTakeFirst();
  if (!existing)
    await insertPricingSnapshot(db, tenant, itemId, { source: 'ai_estimate', payload });
}

export interface CurrentSnapshots {
  /** The snapshot of `analysisId`'s estimate, when there is one. */
  estimate: AiEstimateSnapshot | undefined;
  /** The latest unexpired snapshot per real sold data source and marketplace context. */
  soldData: SoldDataSnapshot[];
  /** Rows whose payload does not match their source's schema; they are never shown. */
  invalidIds: string[];
}

/** The item's snapshots that are still current at `now`. */
export async function currentSnapshots(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
  analysisId: string | undefined,
  now: Date,
): Promise<CurrentSnapshots> {
  const rows = await db
    .selectFrom('pricing_snapshot')
    .select(['id', 'source', 'payload', 'fetched_at'])
    .where('account_id', '=', tenant.accountId)
    .where('item_id', '=', itemId)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
    .orderBy('fetched_at', 'desc')
    .orderBy('id', 'desc')
    .execute();

  const result: CurrentSnapshots = { estimate: undefined, soldData: [], invalidIds: [] };
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.source === 'ai_estimate') {
      const parsed = aiEstimatePayloadSchema.safeParse(row.payload);
      if (!parsed.success) result.invalidIds.push(row.id);
      else if (result.estimate === undefined && parsed.data.analysisId === analysisId) {
        result.estimate = { payload: parsed.data, fetchedAt: row.fetched_at };
      }
      continue;
    }
    if (!isRealSoldDataSource(row.source)) continue;
    const parsed = soldDataPayloadSchemaFor(row.source).safeParse(row.payload);
    if (!parsed.success) {
      result.invalidIds.push(row.id);
      continue;
    }
    const key = `${row.source}:${parsed.data.marketplace ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.soldData.push({ source: row.source, payload: parsed.data, fetchedAt: row.fetched_at });
  }
  return result;
}

/**
 * The account's recent single-item sales per marketplace that have actual marketplace or
 * payment fees, newest first, each with its sale day and every such fee line (refunds and
 * zero-amount lines included, so `calibrateFees` can leave incomplete sales out). Canceled and
 * returned sales are left out, and so are bundles, whose order-level fees cannot be compared
 * with one item's estimate.
 */
export async function recentObservedSales(
  db: DbExecutor,
  tenant: Tenant,
  now: Date,
): Promise<Map<Marketplace, ObservedSale[]>> {
  const since = new Date(now.getTime() - FEE_CALIBRATION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .with('sale_total', (cte) =>
      cte
        .selectFrom('sale')
        .innerJoin('sale_item', (join) =>
          join
            .onRef('sale_item.account_id', '=', 'sale.account_id')
            .onRef('sale_item.sale_id', '=', 'sale.id'),
        )
        .innerJoin('fee_line', (join) =>
          join
            .onRef('fee_line.account_id', '=', 'sale.account_id')
            .onRef('fee_line.sale_id', '=', 'sale.id'),
        )
        .where('sale.account_id', '=', tenant.accountId)
        .where('sale.status', 'in', STANDING_SALE_STATUSES)
        .where('sale.sold_at', '>=', since)
        .where('fee_line.source', '=', 'actual')
        .where('fee_line.kind', 'in', ['marketplace', 'payment'])
        .groupBy(['sale.id', 'sale.marketplace', 'sale.sold_at'])
        .having(sql<number>`count(distinct sale_item.id)`, '=', 1)
        .select([
          'sale.id',
          'sale.marketplace',
          'sale.sold_at',
          sql<number>`max(sale_item.sale_price_cents)`.as('sale_price_cents'),
          // Joined once per fee line and once per item: one item, so each fee counts once.
          sql<
            ObservedFee[]
          >`jsonb_agg(jsonb_build_object('kind', fee_line.kind, 'amountCents', fee_line.amount_cents) order by fee_line.id)`.as(
            'fees',
          ),
          sql<number>`row_number() over (partition by sale.marketplace order by sale.sold_at desc, sale.id desc)`.as(
            'recency',
          ),
        ]),
    )
    .selectFrom('sale_total')
    .select(['marketplace', 'sold_at', 'sale_price_cents', 'fees'])
    .where('recency', '<=', FEE_CALIBRATION_SALES)
    .orderBy('marketplace')
    .orderBy('recency')
    .execute();

  const sales = new Map<Marketplace, ObservedSale[]>();
  for (const row of rows) {
    const list = sales.get(row.marketplace) ?? [];
    list.push({ soldAt: row.sold_at, salePriceCents: row.sale_price_cents, fees: row.fees });
    sales.set(row.marketplace, list);
  }
  return sales;
}

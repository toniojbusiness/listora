/**
 * `pricing_snapshot.payload` shapes, one per source. Snapshots are validated when written and
 * again when read, so a malformed row is never shown as data.
 */
import { knownMarketplaceValues, type KnownMarketplace } from '@listora/api-contract';
import { z } from 'zod';

import type { RealSoldDataSource } from './sources.ts';

const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const money = z.object({ amountCents: cents, currency: z.literal('USD') }).strict();
const marketplace = z.enum(knownMarketplaceValues as [KnownMarketplace, ...KnownMarketplace[]]);

function ordered(low: number, middle: number, high: number): boolean {
  return low <= middle && middle <= high;
}

/** Real sold data: a sample's price range, with the label its source requires. */
export const soldDataPayloadSchema = z
  .object({
    /** For example "Sold on Depop (last 90 days)". */
    label: z.string().min(1).max(120),
    sampleSize: z.number().int().min(1).max(2_147_483_647),
    low: money,
    median: money,
    high: money,
    /** Set when the data may be shown only in that marketplace's listing context. */
    marketplace: marketplace.optional(),
  })
  .strict()
  .refine((data) => ordered(data.low.amountCents, data.median.amountCents, data.high.amountCents), {
    message: 'low, median, and high must be in order',
  });
export type SoldDataPayload = z.infer<typeof soldDataPayloadSchema>;

/** The price estimate of one AI analysis. Never sold data. */
export const aiEstimatePayloadSchema = z
  .object({
    analysisId: z.uuid(),
    low: money,
    mid: money,
    high: money,
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .refine((data) => ordered(data.low.amountCents, data.mid.amountCents, data.high.amountCents), {
    message: 'low, mid, and high must be in order',
  });
export type AiEstimatePayload = z.infer<typeof aiEstimatePayloadSchema>;

/** A real sold data snapshot, as the suggestion builder uses it. */
export interface SoldDataSnapshot {
  readonly source: RealSoldDataSource;
  readonly payload: SoldDataPayload;
  readonly fetchedAt: Date;
}

/** An AI estimate snapshot, as the suggestion builder uses it. */
export interface AiEstimateSnapshot {
  readonly payload: AiEstimatePayload;
  readonly fetchedAt: Date;
}

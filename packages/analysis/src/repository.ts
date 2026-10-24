/**
 * `ai_analysis` rows: one per item, photo set, and tier. Requesting an analysis that exists
 * returns it instead of paying for it again; one that failed is queued again, since a person
 * asking again is the retry. Every function filters on the account.
 */
import type { AnalysisResult } from '@listora/api-contract';
import { jsonb, type AiAnalysisTable, type DbExecutor, type JsonObject } from '@listora/db';
import type { Selectable } from 'kysely';

import type { AiTier } from '@listora/ai';

import type { AnalysisJobQueue } from './queue.ts';

export type AnalysisRow = Selectable<AiAnalysisTable>;

export async function findAnalysis(
  db: DbExecutor,
  accountId: string,
  analysisId: string,
): Promise<AnalysisRow | undefined> {
  return db
    .selectFrom('ai_analysis')
    .selectAll()
    .where('account_id', '=', accountId)
    .where('id', '=', analysisId)
    .executeTakeFirst();
}

export async function findItemAnalysis(
  db: DbExecutor,
  accountId: string,
  key: { itemId: string; photoSetHash: string; tier: AiTier },
): Promise<AnalysisRow | undefined> {
  return db
    .selectFrom('ai_analysis')
    .selectAll()
    .where('account_id', '=', accountId)
    .where('item_id', '=', key.itemId)
    .where('photo_set_hash', '=', key.photoSetHash)
    .where('tier', '=', key.tier)
    .executeTakeFirst();
}

/** The premium analysis that escalates this one, if any. */
export async function findEscalation(
  db: DbExecutor,
  accountId: string,
  analysisId: string,
): Promise<AnalysisRow | undefined> {
  return db
    .selectFrom('ai_analysis')
    .selectAll()
    .where('account_id', '=', accountId)
    .where('escalated_from_analysis_id', '=', analysisId)
    .executeTakeFirst();
}

export interface AnalysisRequest {
  accountId: string;
  itemId: string;
  photoSetHash: string;
  tier: AiTier;
  /** The model the tier is served by now (`AiClient.modelFor`). */
  model: string;
  requestedByUserId: string | null;
  /** Required for `premium`: the completed standard analysis to escalate. */
  escalatedFromAnalysisId?: string;
}

export interface RequestedAnalysis {
  row: AnalysisRow;
  /** False when the analysis already existed and was not failed, so nothing was queued. */
  queued: boolean;
}

/**
 * The analysis for an item's photo set and tier: an existing one as it is, a failed one
 * queued again, or a new one. A new or requeued analysis gets its job in the caller's
 * transaction, so the row and its job commit together. Concurrent requests for the same key
 * resolve to one row through the unique key; callers that hold the item's row lock never
 * race at all.
 */
export async function requestAnalysis(
  trx: DbExecutor,
  jobs: AnalysisJobQueue,
  request: AnalysisRequest,
): Promise<RequestedAnalysis> {
  const inserted = await trx
    .insertInto('ai_analysis')
    .values({
      account_id: request.accountId,
      item_id: request.itemId,
      photo_set_hash: request.photoSetHash,
      tier: request.tier,
      model: request.model,
      requested_by_user_id: request.requestedByUserId,
      escalated_from_analysis_id: request.escalatedFromAnalysisId ?? null,
    })
    .onConflict((conflict) =>
      conflict.columns(['account_id', 'item_id', 'photo_set_hash', 'tier']).doNothing(),
    )
    .returningAll()
    .executeTakeFirst();
  if (inserted !== undefined) {
    await jobs.enqueue(trx, { accountId: request.accountId, analysisId: inserted.id });
    return { row: inserted, queued: true };
  }

  const existing = await findItemAnalysis(trx, request.accountId, request);
  if (existing === undefined) throw new Error('analysis conflict without an existing row');
  if (existing.status !== 'failed') return { row: existing, queued: false };
  const requeued = await trx
    .updateTable('ai_analysis')
    .set({
      status: 'pending',
      model: request.model,
      requested_by_user_id: request.requestedByUserId,
      attempts: 0,
      error_code: null,
      error_message: null,
      error_retryable: null,
      completed_at: null,
    })
    .where('account_id', '=', request.accountId)
    .where('id', '=', existing.id)
    .where('status', '=', 'failed')
    .returningAll()
    .executeTakeFirst();
  if (requeued === undefined) return { row: existing, queued: false };
  await jobs.enqueue(trx, { accountId: request.accountId, analysisId: requeued.id });
  return { row: requeued, queued: true };
}

/** A completed analysis's result; the database guarantees one when it succeeded. */
export function analysisResultOf(row: AnalysisRow): AnalysisResult | undefined {
  if (row.status !== 'succeeded' || row.output === null) return undefined;
  return row.output as unknown as AnalysisResult;
}

export function resultJson(result: AnalysisResult) {
  return jsonb(result as unknown as JsonObject);
}

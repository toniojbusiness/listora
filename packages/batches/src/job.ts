/**
 * The batch item job: once the app has attached every photo of a batch item (it submitted the
 * item), it starts the item's analysis as soon as the server has processed the photos, so the
 * seller finds each item analyzed when they reach it in the rapid review, while they keep
 * shooting. It runs in the worker's task pool, next to photo processing and the analyses
 * themselves, never in the pool of marketplace operation steps.
 *
 * Starting goes through the same rules as `startItemAnalysis`: the existing analysis of the
 * photo set is kept (never paid for twice), a failed one is queued again (a submit is the
 * seller's Retry), and the AI guards are checked first, so a request they would refuse is
 * recorded as the reason instead of queued. While photos are still processing the job checks
 * again a moment later, and gives up with a retryable reason after a deadline, so an item never
 * waits forever.
 */
import { AiGuardError, type AiClient } from '@listora/ai';
import {
  ANALYSIS_PURPOSE,
  ANALYSIS_QUOTA,
  analysisFailure,
  findItemAnalysis,
  requestAnalysis,
  type AnalysisJobQueue,
} from '@listora/analysis';
import { inTransaction, type Db } from '@listora/db';
import { itemPhotoSet } from '@listora/photos';
import type { Logger } from '@listora/shared';

import type { BatchJobPayload, BatchJobQueue } from './queue.ts';
import { findBatch, findBatchItem, recordStartError } from './repository.ts';

export interface BatchJobTiming {
  /** How long the job waits before it checks the photos again. */
  pollDelayMs: number;
  /** How long after the submit it keeps waiting for the photos to be processed. */
  photoDeadlineMs: number;
}

export const DEFAULT_BATCH_JOB_TIMING: BatchJobTiming = {
  pollDelayMs: 2_000,
  // Photo processing takes seconds; its own job retries outages for much longer, and a
  // resubmit after this deadline starts the wait again.
  photoDeadlineMs: 15 * 60_000,
};

export interface BatchJobDependencies {
  db: Db;
  /** Its guards decide whether the analysis may start; it is never called. */
  ai: AiClient;
  /** Where the started analysis's job goes. */
  analysisJobs: AnalysisJobQueue;
  /** Where the job queues itself again while photos process. */
  batchJobs: BatchJobQueue;
  logger: Logger;
  now?: () => Date;
  timing?: BatchJobTiming;
}

/**
 * - `started`: the analysis is queued (new, or a failed one again).
 * - `already_analyzed`: the photo set's analysis exists and did not fail; nothing to pay for.
 * - `waiting_for_photos`: photos are still processing; the job runs again shortly.
 * - `blocked`: an AI guard refused it; the reason is on the batch item.
 * - `photos_timed_out`: the photos were not processed in time; the reason is on the batch item.
 * - `no_photos`: the item has no photos left; the reason is on the batch item.
 * - `photo_failed`: a photo could not be processed; the batch item shows that photo's reason.
 * - `skipped`: nothing to do (the item is saved, gone, out of the batch, or not submitted).
 */
export type BatchJobOutcome =
  | 'started'
  | 'already_analyzed'
  | 'waiting_for_photos'
  | 'blocked'
  | 'photos_timed_out'
  | 'no_photos'
  | 'photo_failed'
  | 'skipped';

export async function startBatchItemAnalysis(
  deps: BatchJobDependencies,
  job: BatchJobPayload,
): Promise<BatchJobOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const timing = deps.timing ?? DEFAULT_BATCH_JOB_TIMING;
  const log = deps.logger.child({
    accountId: job.accountId,
    batchId: job.batchId,
    itemId: job.itemId,
  });
  const key = { accountId: job.accountId, batchId: job.batchId, itemId: job.itemId };
  const outcome = await inTransaction(deps.db, async (trx): Promise<BatchJobOutcome> => {
    // The item lock orders this against photo changes, saves, and `startItemAnalysis`.
    const item = await trx
      .selectFrom('inventory_item')
      .select(['status'])
      .where('account_id', '=', job.accountId)
      .where('id', '=', job.itemId)
      .forUpdate()
      .executeTakeFirst();
    const batchItem = await findBatchItem(trx, job.accountId, job.batchId, job.itemId);
    const submittedAt = batchItem?.submitted_at ?? null;
    if (item === undefined || submittedAt === null || item.status !== 'draft') return 'skipped';

    const photoSet = await itemPhotoSet(trx, job.accountId, job.itemId);
    if (photoSet === undefined) {
      await recordStartError(trx, key, {
        code: 'no_photos',
        message: 'This item has no photos. Add photos, then try again.',
        retryable: false,
      });
      return 'no_photos';
    }
    if (photoSet.photos.some((photo) => photo.status === 'failed')) return 'photo_failed';
    if (photoSet.photos.some((photo) => photo.status === 'processing')) {
      if (now.getTime() - submittedAt.getTime() >= timing.photoDeadlineMs) {
        await recordStartError(trx, key, {
          code: 'photos_not_ready',
          message: 'Your photos are taking longer than usual to prepare. Try again in a moment.',
          retryable: true,
        });
        return 'photos_timed_out';
      }
      await deps.batchJobs.enqueue(trx, job, new Date(now.getTime() + timing.pollDelayMs));
      return 'waiting_for_photos';
    }

    const analysisKey = {
      itemId: job.itemId,
      photoSetHash: photoSet.hash,
      tier: 'standard',
    } as const;
    const existing = await findItemAnalysis(trx, job.accountId, analysisKey);
    if (existing !== undefined && existing.status !== 'failed') return 'already_analyzed';
    try {
      await deps.ai.checkGuards({
        accountId: job.accountId,
        tier: 'standard',
        purpose: ANALYSIS_PURPOSE,
        quota: ANALYSIS_QUOTA.standard,
      });
    } catch (error) {
      if (!(error instanceof AiGuardError)) throw error;
      await recordStartError(trx, key, analysisFailure(error));
      return 'blocked';
    }
    const batch = await findBatch(trx, job.accountId, job.batchId);
    await requestAnalysis(trx, deps.analysisJobs, {
      accountId: job.accountId,
      ...analysisKey,
      model: deps.ai.modelFor('standard'),
      requestedByUserId: batch?.created_by_user_id ?? null,
    });
    return 'started';
  });
  if (outcome !== 'waiting_for_photos') log.info({ outcome }, 'batch item analysis start');
  return outcome;
}

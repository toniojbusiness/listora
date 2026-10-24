/**
 * The analysis job: one run takes a queued analysis to `succeeded` with its result, or to
 * `failed` with a reason the user can read and whether trying again may help. It never leaves
 * an analysis claiming success it did not have, and never leaves one running after it ends:
 * every failure, expected or not, is recorded on the row.
 *
 * A standard analysis that asks for escalation queues its premium analysis in the same
 * transaction as its result, when automatic escalation is on, the reason is worth a premium
 * call without the user asking (not just an unidentified brand or product), and the plan's
 * premium quota still allows one.
 */
import { AiGuardError, type AiClient } from '@listora/ai';
import { inTransaction, type Db } from '@listora/db';
import type { Logger } from '@listora/shared';
import type { ObjectStorage } from '@listora/storage';

import { ANALYSIS_PURPOSE, ANALYSIS_QUOTA, AnalysisFailedError, analyzeItem } from './analyze.ts';
import { loadAnalysisInput } from './load-input.ts';
import type { AnalysisJobPayload, AnalysisJobQueue } from './queue.ts';
import {
  analysisResultOf,
  findAnalysis,
  requestAnalysis,
  resultJson,
  type AnalysisRow,
} from './repository.ts';

export interface AnalysisJobDependencies {
  db: Db;
  storage: ObjectStorage;
  ai: AiClient;
  /** Where an automatic escalation's job goes. */
  jobs: AnalysisJobQueue;
  logger: Logger;
  /** `AI_AUTO_ESCALATE`: queue the premium analysis when a standard one asks for it. */
  autoEscalate: boolean;
}

/**
 * - `succeeded` / `failed`: the analysis finished this way in this run.
 * - `skipped`: nothing to do (already finished, requeued meanwhile, or deleted).
 */
export type AnalysisJobOutcome = 'succeeded' | 'failed' | 'skipped';

export async function runItemAnalysis(
  deps: AnalysisJobDependencies,
  job: AnalysisJobPayload,
): Promise<AnalysisJobOutcome> {
  const log = deps.logger.child({ analysisId: job.analysisId, accountId: job.accountId });
  // A run that crashed leaves the row `running`; the queue's next run takes it over.
  const analysis = await deps.db
    .updateTable('ai_analysis')
    .set({ status: 'running' })
    .where('account_id', '=', job.accountId)
    .where('id', '=', job.analysisId)
    .where('status', 'in', ['pending', 'running'])
    .returningAll()
    .executeTakeFirst();
  if (analysis === undefined) {
    log.info('analysis is finished or gone; nothing to do');
    return 'skipped';
  }

  try {
    const firstAnalysis = await escalatedResult(deps, analysis);
    const input = await loadAnalysisInput(deps.db, deps.storage, analysis);
    const outcome = await analyzeItem(deps.ai, input, {
      tier: analysis.tier,
      ...(firstAnalysis === undefined ? {} : { firstAnalysis }),
    });
    const escalate =
      analysis.tier === 'standard' &&
      outcome.autoEscalate &&
      deps.autoEscalate &&
      (await premiumAllowed(deps, analysis, log));
    const stored = await inTransaction(deps.db, async (trx) => {
      const updated = await trx
        .updateTable('ai_analysis')
        .set({
          status: 'succeeded',
          model: outcome.model,
          output: resultJson(outcome.result),
          attempts: outcome.attempts,
          completed_at: new Date(),
        })
        .where('account_id', '=', job.accountId)
        .where('id', '=', job.analysisId)
        .where('status', '=', 'running')
        .executeTakeFirst();
      if (updated.numUpdatedRows === 0n) return false;
      if (escalate) {
        await requestAnalysis(trx, deps.jobs, {
          accountId: analysis.account_id,
          itemId: analysis.item_id,
          photoSetHash: analysis.photo_set_hash,
          tier: 'premium',
          model: deps.ai.modelFor('premium'),
          requestedByUserId: analysis.requested_by_user_id,
          escalatedFromAnalysisId: analysis.id,
        });
      }
      return true;
    });
    if (!stored) {
      log.info('analysis changed while this run worked; its result is discarded');
      return 'skipped';
    }
    log.info(
      {
        tier: analysis.tier,
        attempts: outcome.attempts,
        costMicros: outcome.costMicros,
        needsEscalation: outcome.result.needsEscalation,
        escalated: escalate,
      },
      'analysis succeeded',
    );
    return 'succeeded';
  } catch (error) {
    const failure =
      error instanceof AnalysisFailedError
        ? error
        : new AnalysisFailedError(
            {
              code: 'internal_error',
              message: 'The analysis failed unexpectedly. Try again.',
              retryable: true,
            },
            { attempts: 0, costMicros: 0 },
            { cause: error },
          );
    if (failure.code === 'internal_error') log.error({ err: error }, 'analysis failed');
    // The cause carries the provider's own reason (a rejected request, an outage), never a key.
    else
      log.info({ code: failure.code, attempts: failure.attempts, err: error }, 'analysis failed');
    const updated = await deps.db
      .updateTable('ai_analysis')
      .set({
        status: 'failed',
        error_code: failure.code,
        error_message: failure.message,
        error_retryable: failure.retryable,
        attempts: failure.attempts,
        completed_at: new Date(),
      })
      .where('account_id', '=', job.accountId)
      .where('id', '=', job.analysisId)
      .where('status', '=', 'running')
      .executeTakeFirst();
    return updated.numUpdatedRows === 0n ? 'skipped' : 'failed';
  }
}

/** For a premium analysis, the result of the standard analysis it escalates. */
async function escalatedResult(deps: AnalysisJobDependencies, analysis: AnalysisRow) {
  if (analysis.escalated_from_analysis_id === null) return undefined;
  const source = await findAnalysis(
    deps.db,
    analysis.account_id,
    analysis.escalated_from_analysis_id,
  );
  const result = source === undefined ? undefined : analysisResultOf(source);
  if (result === undefined) {
    throw new AnalysisFailedError(
      {
        code: 'escalation_source_missing',
        message: 'The first analysis of these photos is gone. Analyze the item again.',
        retryable: false,
      },
      { attempts: 0, costMicros: 0 },
    );
  }
  return result;
}

/** Whether the guards would let a premium call run now; an automatic escalation needs it. */
async function premiumAllowed(
  deps: AnalysisJobDependencies,
  analysis: AnalysisRow,
  log: Logger,
): Promise<boolean> {
  try {
    await deps.ai.checkGuards({
      accountId: analysis.account_id,
      tier: 'premium',
      purpose: ANALYSIS_PURPOSE,
      quota: ANALYSIS_QUOTA.premium,
    });
    return true;
  } catch (error) {
    if (error instanceof AiGuardError) {
      log.info({ reason: error.reason.kind }, 'not escalating automatically: a guard refuses it');
    } else {
      // The analysis itself succeeded; the user can still ask for the premium one.
      log.warn({ err: error }, 'not escalating automatically: the guards could not be checked');
    }
    return false;
  }
}

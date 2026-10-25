import { graphileAnalysisJobs } from '@listora/analysis';
import {
  BATCH_ITEM_ANALYSIS_TASK,
  graphileBatchJobs,
  isBatchJobPayload,
  startBatchItemAnalysis,
} from '@listora/batches';

import type { WorkerFeature } from '../features.ts';

/**
 * Batch listing (`batch_item_analysis`): starts a submitted batch item's analysis once its
 * photos are processed, checking again shortly while they are not, so the seller finds each item
 * of a haul analyzed when they reach it. A refusal by the AI guards is recorded on the item.
 */
export const feature: WorkerFeature = {
  jobs: ({ db, ai, logger }) => ({
    tasks: {
      [BATCH_ITEM_ANALYSIS_TASK]: async (payload) => {
        if (!isBatchJobPayload(payload)) {
          logger.error(
            { task: BATCH_ITEM_ANALYSIS_TASK },
            'job with an invalid payload; dropping it',
          );
          return;
        }
        await startBatchItemAnalysis(
          { db, ai, analysisJobs: graphileAnalysisJobs, batchJobs: graphileBatchJobs, logger },
          payload,
        );
      },
    },
  }),
};

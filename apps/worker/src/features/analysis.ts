import {
  graphileAnalysisJobs,
  isAnalysisJobPayload,
  ITEM_ANALYSIS_TASK,
  runItemAnalysis,
} from '@listora/analysis';

import type { WorkerFeature } from '../features.ts';

/**
 * Item analysis (`item_analysis`) of an item's ready photos, premium identifications included
 * (an automatic escalation's job goes back on the same queue). The job records its outcome on
 * the analysis, failures included, so the app shows a failed analysis with its reason rather
 * than one that waits forever.
 */
export const feature: WorkerFeature = {
  jobs: ({ config, db, storage, ai, logger }) => ({
    tasks: {
      [ITEM_ANALYSIS_TASK]: async (payload) => {
        if (!isAnalysisJobPayload(payload)) {
          logger.error({ task: ITEM_ANALYSIS_TASK }, 'job with an invalid payload; dropping it');
          return;
        }
        await runItemAnalysis(
          {
            db,
            storage,
            ai,
            logger,
            autoEscalate: config.analysis.autoEscalate,
            jobs: graphileAnalysisJobs,
          },
          payload,
        );
      },
    },
  }),
};

import type { AiClient } from '@listora/ai';
import {
  graphileAnalysisJobs,
  isAnalysisJobPayload,
  ITEM_ANALYSIS_TASK,
  runItemAnalysis,
} from '@listora/analysis';
import type { Db } from '@listora/db';
import type { WorkerTask } from '@listora/operations';
import { isPhotoJobPayload, PHOTO_PROCESSING_TASK, processPhoto } from '@listora/photos';
import type { Logger } from '@listora/shared';
import type { ObjectStorage } from '@listora/storage';

export interface WorkerTaskDependencies {
  db: Db;
  storage: ObjectStorage;
  ai: AiClient;
  logger: Logger;
  /** `AI_AUTO_ESCALATE`. */
  autoEscalate: boolean;
}

/**
 * The jobs the worker runs besides operation steps: photo processing, then item analysis of
 * the ready photos, premium identifications included (an automatic escalation's job goes back
 * on the same queue). Each job records its outcome on its own row, failures included, so the
 * app shows a failed photo or analysis with its reason rather than one that waits forever.
 */
export function createWorkerTasks(deps: WorkerTaskDependencies): Record<string, WorkerTask> {
  return {
    [PHOTO_PROCESSING_TASK]: async (payload) => {
      if (!isPhotoJobPayload(payload)) {
        deps.logger.error(
          { task: PHOTO_PROCESSING_TASK },
          'job with an invalid payload; dropping it',
        );
        return;
      }
      await processPhoto(deps, payload);
    },
    [ITEM_ANALYSIS_TASK]: async (payload) => {
      if (!isAnalysisJobPayload(payload)) {
        deps.logger.error({ task: ITEM_ANALYSIS_TASK }, 'job with an invalid payload; dropping it');
        return;
      }
      await runItemAnalysis({ ...deps, jobs: graphileAnalysisJobs }, payload);
    },
  };
}

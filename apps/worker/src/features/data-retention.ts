import { DATA_RETENTION_SCHEDULE, DATA_RETENTION_TASK, runDataRetention } from '@listora/retention';

import type { WorkerFeature } from '../features.ts';

/**
 * The daily retention job (`data_retention`, docs/features/privacy.md): deletes expired
 * operation history, raw marketplace payloads, AI usage events, connections revoked long ago,
 * old connect attempts, and old deletion records.
 */
export const feature: WorkerFeature = {
  jobs: ({ db, logger }) => ({
    scheduledTasks: [
      {
        name: DATA_RETENTION_TASK,
        schedule: DATA_RETENTION_SCHEDULE,
        run: async () => {
          await runDataRetention({ db, logger });
        },
      },
    ],
  }),
};

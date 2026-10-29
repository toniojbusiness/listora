import { DATA_RETENTION_SCHEDULE, DATA_RETENTION_TASK, runDataRetention } from '@listora/retention';

import type { WorkerFeature } from '../features.ts';

/**
 * The daily retention job (`data_retention`, docs/features/privacy.md): deletes expired
 * operation history, raw marketplace payloads, AI usage events, connections revoked long ago,
 * old connect attempts, and old deletion records; with `BUYER_DATA_RETENTION=on`, also clears
 * buyers' names and tracking numbers past their retention (off, it logs what it would clear).
 */
export const feature: WorkerFeature = {
  jobs: ({ config, db, logger }) => ({
    scheduledTasks: [
      {
        name: DATA_RETENTION_TASK,
        schedule: DATA_RETENTION_SCHEDULE,
        run: async () => {
          await runDataRetention({ db, logger, buyerData: config.buyerDataRetention });
        },
      },
    ],
  }),
};

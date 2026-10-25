import { AUTO_DELIST_SLA_SCHEDULE, AUTO_DELIST_SLA_TASK, runDelistSla } from '@listora/auto-delist';

import type { WorkerFeature } from '../features.ts';

/**
 * The delist SLA (`auto_delist_sla`, every minute): completes delist runs whose listings are all
 * delisted or confirmed, and re-alerts the seller 10 and 30 minutes after a sale that still is
 * not delisted everywhere (docs/features/auto-delist.md). The fan-out itself runs where sales
 * are recorded, in their transaction.
 */
export const feature: WorkerFeature = {
  jobs: ({ db, logger }) => ({
    scheduledTasks: [
      {
        name: AUTO_DELIST_SLA_TASK,
        schedule: AUTO_DELIST_SLA_SCHEDULE,
        // A missed minute is covered by the next one.
        maxAttempts: 1,
        run: async () => {
          await runDelistSla({ db, logger });
        },
      },
    ],
  }),
};

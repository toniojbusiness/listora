import {
  runSaleCheckHealth,
  SALE_CHECK_HEALTH_SCHEDULE,
  SALE_CHECK_HEALTH_TASK,
} from '@listora/automation';

import type { WorkerFeature } from '../features.ts';

/**
 * Sale-check health (`sale_check_health`, every 5 minutes): marks automation connections whose
 * sale check is overdue and tells the seller, once per problem, that a marketplace's sales are
 * not being checked and why (docs/features/activity.md).
 */
export const feature: WorkerFeature = {
  jobs: ({ config, db, logger }) => ({
    scheduledTasks: [
      {
        name: SALE_CHECK_HEALTH_TASK,
        schedule: SALE_CHECK_HEALTH_SCHEDULE,
        // A missed tick is covered by the next one.
        maxAttempts: 1,
        run: async () => {
          await runSaleCheckHealth({ db, settings: config.automation.saleChecks, logger });
        },
      },
    ],
  }),
};

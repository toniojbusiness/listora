import { isAutomatedMarketplace } from '@listora/automation';
import {
  LISTING_REFRESH_SCHEDULE,
  LISTING_REFRESH_TASK,
  runListingRefreshes,
} from '@listora/listing-refresh';

import type { WorkerFeature } from '../features.ts';

/**
 * The refresh schedule (`listing_refresh`, every 5 minutes): queues a refresh for each live
 * listing that went its interval without selling, within its marketplace session's run limits
 * and outside the seller's quiet window (docs/features/listing-refresh.md).
 */
export const feature: WorkerFeature = {
  jobs: ({ config, db, adapters, logger }) => ({
    scheduledTasks: [
      {
        name: LISTING_REFRESH_TASK,
        schedule: LISTING_REFRESH_SCHEDULE,
        // A missed tick is covered by the next one: due listings stay due.
        maxAttempts: 1,
        run: async () => {
          await runListingRefreshes({
            db,
            adapters,
            limits: (marketplace) =>
              isAutomatedMarketplace(marketplace)
                ? config.automation.profiles[marketplace].limits
                : undefined,
            logger,
          });
        },
      },
    ],
  }),
};

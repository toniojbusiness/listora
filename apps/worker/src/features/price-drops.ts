import { isAutomatedMarketplace } from '@listora/automation';
import { PRICE_DROPS_SCHEDULE, PRICE_DROPS_TASK, runPriceDrops } from '@listora/price-drops';

import type { WorkerFeature } from '../features.ts';

/**
 * The price drop schedule (`price_drops`, every 5 minutes): runs each live listing's drop that
 * is due under the seller's rules, as a price change confirmed by a read-back, within the daily
 * cap and its marketplace session's pace (docs/features/price-drops.md).
 */
export const feature: WorkerFeature = {
  jobs: ({ config, db, adapters, logger }) => ({
    scheduledTasks: [
      {
        name: PRICE_DROPS_TASK,
        schedule: PRICE_DROPS_SCHEDULE,
        // A missed tick is covered by the next one: due drops stay due.
        maxAttempts: 1,
        run: async () => {
          await runPriceDrops({
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

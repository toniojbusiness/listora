import { checkSaleFees, isSaleFeesPayload, SALE_FEES_TASK } from '@listora/sales';

import type { WorkerFeature } from '../features.ts';

/**
 * A sale's actual fees (`sale_fees`, docs/features/sales.md): asks the marketplace for the fees
 * it charged on the order and replaces the sale's estimated fee lines with them, or queues the
 * next check while the marketplace has not reported them yet.
 */
export const feature: WorkerFeature = {
  jobs: ({ db, adapters, logger }) => ({
    tasks: {
      [SALE_FEES_TASK]: async (payload, signal) => {
        if (!isSaleFeesPayload(payload)) {
          logger.error({ task: SALE_FEES_TASK }, 'job with an invalid payload; dropping it');
          return;
        }
        await checkSaleFees({ db, adapters, logger }, payload, signal);
      },
    },
  }),
};

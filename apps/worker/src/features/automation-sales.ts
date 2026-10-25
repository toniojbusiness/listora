import { isSaleOrderJobPayload, recordSaleOrder, SALE_ORDER_TASK } from '@listora/automation';

import type { WorkerFeature } from '../features.ts';

/**
 * The sales automated sale checks find (`automation_sale_order`): the browser runner stores each
 * new order and queues this job, and the worker records its sale, which starts its auto-delist
 * (docs/features/automation.md). The worker records it because the fan-out needs its adapters.
 */
export const feature: WorkerFeature = {
  jobs: ({ db, adapters, logger }) => ({
    tasks: {
      [SALE_ORDER_TASK]: async (payload) => {
        if (!isSaleOrderJobPayload(payload)) {
          logger.error({ task: SALE_ORDER_TASK }, 'job with an invalid payload; dropping it');
          return;
        }
        await recordSaleOrder({ db, adapters, logger }, payload);
      },
    },
  }),
};

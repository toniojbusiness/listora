import { isSaleOrderJobPayload, recordSaleOrder, SALE_ORDER_TASK } from '@listora/automation';
import { soldItemMaker } from '@listora/imports';

import type { WorkerFeature } from '../features.ts';
import { importPhotoFetcher } from '../import-photos.ts';

/**
 * The sales automated sale checks find (`automation_sale_order`): the browser runner stores each
 * new order and queues this job, and the worker records its sale, which starts its auto-delist
 * (docs/features/automation.md). The worker records it because the fan-out needs its adapters.
 * A sale of a listing Listora doesn't have gets a sold item of its own, with the listing's photos
 * from the marketplace's image CDN (docs/features/sales.md, "Sales history").
 */
export const feature: WorkerFeature = {
  jobs: ({ config, db, storage, adapters, logger }) => ({
    tasks: {
      [SALE_ORDER_TASK]: async (payload) => {
        if (!isSaleOrderJobPayload(payload)) {
          logger.error({ task: SALE_ORDER_TASK }, 'job with an invalid payload; dropping it');
          return;
        }
        const soldItems = soldItemMaker({ storage, photos: importPhotoFetcher(config), logger });
        await recordSaleOrder({ db, adapters, logger, soldItems }, payload);
      },
    },
  }),
};

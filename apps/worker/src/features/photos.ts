import { isPhotoJobPayload, PHOTO_PROCESSING_TASK, processPhoto } from '@listora/photos';

import type { WorkerFeature } from '../features.ts';

/**
 * Photo processing (`photo_processing`): derives a new photo's images. The job records its
 * outcome on the photo, failures included, so the app shows a failed photo with its reason
 * rather than one that waits forever.
 */
export const feature: WorkerFeature = {
  jobs: ({ db, storage, logger }) => ({
    tasks: {
      [PHOTO_PROCESSING_TASK]: async (payload) => {
        if (!isPhotoJobPayload(payload)) {
          logger.error({ task: PHOTO_PROCESSING_TASK }, 'job with an invalid payload; dropping it');
          return;
        }
        await processPhoto({ db, storage, logger }, payload);
      },
    },
  }),
};

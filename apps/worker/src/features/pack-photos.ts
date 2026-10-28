import {
  PACK_PHOTOS_CRONTAB,
  PACK_PHOTOS_TASK,
  queuePackPhotos,
  runPackPhotos,
} from '@listora/pack-check';

import type { WorkerFeature } from '../features.ts';

/**
 * Package photos (`pack_photos`, hourly and at every start, docs/features/pack-check.md):
 * moves the package photos still public to private keys (and asks the CDN to drop its copies),
 * then deletes the ones kept past their days after shipping.
 */
export const feature: WorkerFeature = {
  jobs: ({ db, storage, logger }) => ({
    tasks: {
      [PACK_PHOTOS_TASK]: async () => {
        await runPackPhotos({ db, storage, logger });
      },
    },
    crontab: [PACK_PHOTOS_CRONTAB],
    start: () => queuePackPhotos(db),
  }),
};

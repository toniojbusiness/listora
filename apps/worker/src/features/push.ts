import {
  BACKGROUND_PUSH_TASK,
  createPushSender,
  deliverBackgroundPush,
  deliverPush,
  PUSH_TASK,
} from '@listora/push';

import type { WorkerFeature } from '../features.ts';

/**
 * Push delivery (`push_notification`, `push_background`): sends each notification or
 * background push another feature queued in its transaction, with the driver `PUSH_DRIVER`
 * selects (docs/features/push.md).
 */
export const feature: WorkerFeature = {
  jobs: ({ config, db, logger }) => {
    const sender = createPushSender(config.push, logger, db);
    return {
      tasks: {
        [PUSH_TASK]: (payload, signal) => deliverPush({ sender, logger }, payload, signal),
        [BACKGROUND_PUSH_TASK]: (payload, signal) =>
          deliverBackgroundPush({ sender, logger }, payload, signal),
      },
    };
  },
};

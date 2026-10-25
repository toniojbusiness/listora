import { createPushSender, deliverPush, PUSH_TASK } from '@listora/push';

import type { WorkerFeature } from '../features.ts';

/**
 * Push delivery (`push_notification`): sends each notification another feature queued in its
 * transaction, with the driver `PUSH_DRIVER` selects (docs/features/push.md).
 */
export const feature: WorkerFeature = {
  jobs: ({ config, logger }) => {
    const sender = createPushSender(config.push, logger);
    return {
      tasks: { [PUSH_TASK]: (payload, signal) => deliverPush({ sender, logger }, payload, signal) },
    };
  },
};

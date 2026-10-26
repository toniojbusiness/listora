import { PHONE_WATCH_SCHEDULE, PHONE_WATCH_TASK, watchPhoneWork } from '@listora/automation';

import type { WorkerFeature } from '../features.ts';

/**
 * The watch over work handed to the seller's iPhone (`phone_work_watch`, every minute): a
 * check whose phone run lapsed waits again, unanswered phone calls are closed in the run
 * history, and a phone with work waiting gets a background push
 * (docs/features/phone-execution.md). Operation steps on the phone are rechecked by their own
 * jobs.
 */
export const feature: WorkerFeature = {
  jobs: ({ db, logger }) => ({
    scheduledTasks: [
      {
        name: PHONE_WATCH_TASK,
        schedule: PHONE_WATCH_SCHEDULE,
        // A missed minute is covered by the next one.
        maxAttempts: 1,
        run: async () => {
          await watchPhoneWork({ db, logger });
        },
      },
    ],
  }),
};

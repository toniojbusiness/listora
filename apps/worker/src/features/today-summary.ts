import { runMorningSummaries, TODAY_SUMMARY_SCHEDULE, TODAY_SUMMARY_TASK } from '@listora/today';

import type { WorkerFeature } from '../features.ts';

/**
 * The morning summary (`today_summary`, every 5 minutes): at the time each account chose, in its
 * time zone, one push a day that sums up the Today screen (docs/features/today.md).
 */
export const feature: WorkerFeature = {
  jobs: ({ db, logger }) => ({
    scheduledTasks: [
      {
        name: TODAY_SUMMARY_TASK,
        schedule: TODAY_SUMMARY_SCHEDULE,
        // A missed tick is covered by the next one, within the summary's window.
        maxAttempts: 1,
        run: async () => {
          await runMorningSummaries({ db, logger });
        },
      },
    ],
  }),
};

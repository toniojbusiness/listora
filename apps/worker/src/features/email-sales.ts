import {
  createMailSource,
  EMAIL_INGEST_SCHEDULE,
  EMAIL_INGEST_TASK,
  runEmailIngest,
} from '@listora/email-sales';

import type { WorkerFeature } from '../features.ts';

/**
 * Email sale detection (`email_ingest`, every minute; docs/features/email-sales.md): reads the
 * forwarded mail waiting in the configured source (the inbox folder in development, SES's queue
 * in AWS), records each verified sale (which starts its auto-delist) or makes its confirm or
 * review task, and deletes the raw message. Nothing is scheduled with `EMAIL_INGEST=off`.
 */
export const feature: WorkerFeature = {
  jobs: ({ config, db, adapters, logger }) => {
    const ingest = config.emailIngest;
    const source = createMailSource(ingest, logger);
    if (source === undefined || ingest.driver === 'off') return {};
    const { inboundDomain } = ingest;
    return {
      scheduledTasks: [
        {
          name: EMAIL_INGEST_TASK,
          schedule: EMAIL_INGEST_SCHEDULE,
          // A message left unprocessed is read again by the next run.
          maxAttempts: 1,
          run: async (signal) => {
            await runEmailIngest({ db, adapters, logger, inboundDomain, source }, signal);
          },
        },
      ],
    };
  },
};

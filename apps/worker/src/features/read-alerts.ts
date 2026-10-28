import { SesMailer } from '@listora/alerts';
import {
  READ_ALERTS_SCHEDULE,
  READ_ALERTS_TASK,
  runReadAlerts,
  type OwnerMailer,
} from '@listora/automation';
import type { Logger } from '@listora/shared';
import { assertNever } from '@listora/shared';

import type { WorkerConfig } from '../config.ts';
import type { WorkerFeature } from '../features.ts';

/** How the owner's emails go: through SES, or, in development and tests, only to the log. */
export function ownerMailer(config: WorkerConfig['ownerAlerts'], logger: Logger): OwnerMailer {
  const { delivery } = config;
  switch (delivery.driver) {
    case 'ses':
      return new SesMailer({ from: delivery.from, to: delivery.to });
    case 'log':
      return {
        send: (email) => {
          logger.warn(
            { event: 'owner_alert_email', subject: email.subject, text: email.text },
            'owner alert (OWNER_ALERTS=log: logged, not emailed)',
          );
          return Promise.resolve();
        },
      };
    default:
      return assertNever(delivery);
  }
}

/**
 * Background read alerts (`background_read_alerts`, every 5 minutes): emails the owner, once per
 * run of failures, about a connection's sale check, listing import, or offer check that keeps
 * failing (docs/features/read-health.md).
 */
export const feature: WorkerFeature = {
  jobs: ({ config, db, logger }) => {
    const mailer = ownerMailer(config.ownerAlerts, logger);
    return {
      scheduledTasks: [
        {
          name: READ_ALERTS_TASK,
          schedule: READ_ALERTS_SCHEDULE,
          // A missed tick is covered by the next one, and so is an email that failed to send.
          maxAttempts: 1,
          run: async () => {
            await runReadAlerts({
              db,
              settings: config.automation.readAlerts,
              mailer,
              environment: config.ownerAlerts.environment,
              logger,
            });
          },
        },
      ],
    };
  },
};

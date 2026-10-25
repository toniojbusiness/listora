/**
 * The hourly AI spend check (docs/features/ai.md, spend check). Each run logs one
 * `ai_spend_alert` line per limit an account or the platform is approaching or over, then an
 * `ai_spend_check` summary, through the worker's logger; CloudWatch alarms key on those lines.
 */
import { checkAiSpend, type AiAlertThresholds } from '@listora/ai';
import type { Db } from '@listora/db';
import type { ScheduledTask } from '@listora/operations';
import type { Logger } from '@listora/shared';

import type { WorkerFeature } from '../features.ts';

export const AI_SPEND_CHECK_TASK = 'ai_spend_check';

/** Minute 7 of every hour, UTC. */
export const AI_SPEND_CHECK_SCHEDULE = '7 * * * *';

export function aiSpendCheckTask(
  db: Db,
  thresholds: AiAlertThresholds,
  logger: Logger,
): ScheduledTask {
  return {
    name: AI_SPEND_CHECK_TASK,
    schedule: AI_SPEND_CHECK_SCHEDULE,
    // A failed check is not retried; the next hour's check covers it.
    maxAttempts: 1,
    run: async () => {
      await checkAiSpend(db, thresholds, { logger });
    },
  };
}

/** Runs the check with the thresholds from the worker's own environment. */
export const feature: WorkerFeature = {
  jobs: ({ config, db, logger }) => ({
    scheduledTasks: [aiSpendCheckTask(db, config.aiAlerts, logger)],
  }),
};

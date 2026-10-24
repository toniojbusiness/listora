import {
  ACCOUNT_DELETION_TASK,
  accountDeletionTask,
  AwsCognitoUserAdmin,
  noMarketplaceAccessRevocation,
} from '@listora/accounts';
import {
  createAiClient,
  PostgresAiControls,
  PostgresQuotaPolicy,
  PostgresUsageStore,
} from '@listora/ai';
import { createDatabase } from '@listora/db';
import { startOperationWorker } from '@listora/operations';
import { createLogger, handleShutdownSignals } from '@listora/shared';
import { createStorage } from '@listora/storage';

import { createAdapters } from './adapters.ts';
import { aiSpendCheckTask } from './ai-spend-check.ts';
import { loadWorkerConfig } from './config.ts';
import { createWorkerTasks } from './tasks.ts';

const config = loadWorkerConfig();
const logger = createLogger({ service: 'worker', level: config.logLevel });
const db = createDatabase({
  connectionString: config.databaseUrl,
  max: config.concurrency + config.taskConcurrency + 5,
});

try {
  const worker = await startOperationWorker({
    connectionString: config.databaseUrl,
    db,
    adapters: createAdapters(config).lookup,
    tasks: {
      ...createWorkerTasks({
        db,
        storage: createStorage(config.storage),
        ai: createAiClient(config.ai, {
          usageStore: new PostgresUsageStore(db),
          controls: new PostgresAiControls(db),
          quota: new PostgresQuotaPolicy(db),
          logger,
        }),
        logger,
        autoEscalate: config.analysis.autoEscalate,
      }),
      [ACCOUNT_DELETION_TASK]: accountDeletionTask({
        db,
        cognito: config.cognitoUserPool && new AwsCognitoUserAdmin(config.cognitoUserPool),
        // Marketplace adapters revoke their grants once they add OAuth connections (T-16, T-24).
        marketplaceAccess: noMarketplaceAccessRevocation,
        logger,
      }),
    },
    logger,
    concurrency: config.concurrency,
    taskConcurrency: config.taskConcurrency,
    scheduledTasks: [aiSpendCheckTask(db, config.aiAlerts, logger)],
    onFatalError: (error) => {
      // Other workers recover this worker's jobs once its process is gone; exiting at once
      // is what keeps two workers from running the same step.
      logger.fatal({ err: error }, 'worker cannot continue safely; exiting');
      process.exit(1);
    },
  });

  handleShutdownSignals({
    logger,
    shutdown: async () => {
      await worker.stop();
      await db.destroy();
    },
  });

  logger.info(
    {
      poolId: worker.poolId,
      taskPoolId: worker.taskPoolId,
      fakeMarketplace: config.fakeMarketplaceUrl !== undefined,
      aiProvider: config.ai.provider,
      cognitoUserPool: config.cognitoUserPool?.userPoolId,
    },
    'worker ready',
  );
} catch (error) {
  logger.fatal({ err: error }, 'worker failed to start');
  await db.destroy();
  process.exitCode = 1;
}

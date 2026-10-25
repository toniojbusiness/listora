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
import { createOAuthClients, createTokenVault } from '@listora/connections';
import { createDatabase } from '@listora/db';
import {
  createMetricsEmitter,
  runTrustMetricsTick,
  TRUST_METRICS_CRONTAB,
  TRUST_METRICS_TASK,
} from '@listora/observability';
import { createMarketplaceAdapters } from '@listora/marketplaces';
import { startOperationWorker } from '@listora/operations';
import { createLogger, handleShutdownSignals } from '@listora/shared';
import { createStorage } from '@listora/storage';

import { aiSpendCheckTask } from './ai-spend-check.ts';
import { loadWorkerConfig } from './config.ts';
import { createConnectionWork } from './connections.ts';
import { createWorkerTasks } from './tasks.ts';

const config = loadWorkerConfig();
const logger = createLogger({ service: 'worker', level: config.logLevel });
const db = createDatabase({
  connectionString: config.databaseUrl,
  max: config.concurrency + config.taskConcurrency + 5,
});
const metrics = { db, emitter: createMetricsEmitter({ service: 'worker' }), logger };

// The worker alone opens marketplace tokens: at use time, for the eBay adapter, the health
// check, and account deletion's revocations.
const connections = createConnectionWork({
  db,
  vault: config.marketplaces.tokenVault && createTokenVault(config.marketplaces.tokenVault),
  oauth: createOAuthClients(config.marketplaces),
  ebay: config.marketplaces.ebay,
  logger,
});

try {
  const worker = await startOperationWorker({
    connectionString: config.databaseUrl,
    db,
    adapters: createMarketplaceAdapters(
      {
        ...config.marketplaces,
        ...(connections.ebaySeller === undefined ? {} : { ebaySeller: connections.ebaySeller }),
      },
      logger,
    ).lookup,
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
        marketplaceAccess: connections.revoker ?? noMarketplaceAccessRevocation,
        logger,
      }),
      [TRUST_METRICS_TASK]: (payload) => runTrustMetricsTick(metrics, payload),
    },
    logger,
    concurrency: config.concurrency,
    taskConcurrency: config.taskConcurrency,
    scheduledTasks: [aiSpendCheckTask(db, config.aiAlerts, logger), ...connections.scheduledTasks],
    crontab: [TRUST_METRICS_CRONTAB],
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
      fakeMarketplace: config.marketplaces.fakeMarketplaceUrl !== undefined,
      ebay: config.marketplaces.ebay?.environment ?? null,
      tokenVault: config.marketplaces.tokenVault?.driver ?? null,
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

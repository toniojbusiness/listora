import {
  ACCOUNT_DELETION_TASK,
  accountDeletionTask,
  AwsCognitoUserAdmin,
  noMarketplaceAccessRevocation,
} from '@listora/accounts';
import { fileURLToPath } from 'node:url';

import {
  createAiClient,
  PostgresAiControls,
  PostgresQuotaPolicy,
  PostgresUsageStore,
} from '@listora/ai';
import {
  AUTOMATION_DISPATCH_SCHEDULE,
  AUTOMATION_DISPATCH_TASK,
  AutomationDispatcher,
  createAutomationAdapters,
  createRunnerLauncher,
  HttpPhotoSource,
  NoBrowserSessions,
  ProcessRunnerLauncher,
} from '@listora/automation';
import { createDatabase } from '@listora/db';
import {
  createMetricsEmitter,
  runTrustMetricsTick,
  TRUST_METRICS_CRONTAB,
  TRUST_METRICS_TASK,
} from '@listora/observability';
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
const metrics = { db, emitter: createMetricsEmitter({ service: 'worker' }), logger };

const storage = createStorage(config.storage);
// Automated steps run on the browser runner, which the worker starts when they wait for it.
const launcher = createRunnerLauncher(config.runnerLaunch, {
  logger,
  runnerEntry: fileURLToPath(new URL('runner/main.ts', import.meta.url)),
});
const automation = createAutomationAdapters({
  settings: config.automation,
  sessions: NoBrowserSessions,
  photos: new HttpPhotoSource(),
  logger,
});
const adapters = createAdapters(config, { logger, automation });
const dispatcher = new AutomationDispatcher({
  db,
  launcher,
  storage,
  logger,
  adapters: adapters.lookup,
  deferUnsupportedMs: config.automation.saleChecks.maxIntervalMs,
});

try {
  const worker = await startOperationWorker({
    connectionString: config.databaseUrl,
    db,
    adapters: adapters.lookup,
    tasks: {
      ...createWorkerTasks({
        db,
        storage,
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
      [TRUST_METRICS_TASK]: (payload) => runTrustMetricsTick(metrics, payload),
    },
    logger,
    concurrency: config.concurrency,
    taskConcurrency: config.taskConcurrency,
    scheduledTasks: [
      aiSpendCheckTask(db, config.aiAlerts, logger),
      {
        name: AUTOMATION_DISPATCH_TASK,
        schedule: AUTOMATION_DISPATCH_SCHEDULE,
        run: () => dispatcher.dispatch(),
      },
    ],
    crontab: [TRUST_METRICS_CRONTAB],
    onAutomationHandover: () => {
      dispatcher.nudge();
    },
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
      if (launcher instanceof ProcessRunnerLauncher) launcher.stop();
      await db.destroy();
    },
  });

  logger.info(
    {
      poolId: worker.poolId,
      taskPoolId: worker.taskPoolId,
      fakeMarketplace: config.fakeMarketplaceUrl !== undefined,
      ebay: config.ebay?.environment ?? null,
      aiProvider: config.ai.provider,
      cognitoUserPool: config.cognitoUserPool?.userPoolId,
      automated: Object.keys(automation),
      runnerLaunch: launcher.kind,
    },
    'worker ready',
  );
} catch (error) {
  logger.fatal({ err: error }, 'worker failed to start');
  await db.destroy();
  process.exitCode = 1;
}

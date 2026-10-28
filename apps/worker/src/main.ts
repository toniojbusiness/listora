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
import { createOAuthClients, createTokenVault } from '@listora/connections';
import { createDatabase } from '@listora/db';
import { createMarketplaceAdapters } from '@listora/marketplaces';
import { scaledRetryPolicy, startOperationWorker } from '@listora/operations';
import { limitImageThreads } from '@listora/photos';
import { createLogger, handleShutdownSignals } from '@listora/shared';
import { createStorage } from '@listora/storage';

import { loadWorkerConfig } from './config.ts';
import { createConnectionWork } from './connections.ts';
import { collectWorkerJobs, WORKER_FEATURES } from './features.ts';

const config = loadWorkerConfig();
// Photo processing keeps to one libvips thread, so a burst of photos leaves CPU for the API.
limitImageThreads();
const logger = createLogger({ service: 'worker', level: config.logLevel });
const db = createDatabase({
  connectionString: config.databaseUrl,
  max: config.concurrency + config.taskConcurrency + 5,
});

// The worker opens marketplace OAuth tokens: at use time, for the eBay adapter, the health
// check, and account deletion's revocations. Browser sessions only the browser runner opens.
const connections = createConnectionWork({
  db,
  vault: config.marketplaces.tokenVault && createTokenVault(config.marketplaces.tokenVault),
  oauth: createOAuthClients(config.marketplaces),
  ebay: config.marketplaces.ebay,
  logger,
});

const storage = createStorage(config.storage);
// Automated steps run on the browser runner (docs/features/automation.md): the engine hands
// them over, and the dispatcher starts the runner whenever automated work waits for it. The
// worker's automation adapters have no browser; they only route each operation to its mode.
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
const adapters = createMarketplaceAdapters(
  {
    ...config.marketplaces,
    ...(connections.ebaySeller === undefined ? {} : { ebaySeller: connections.ebaySeller }),
    automation,
  },
  logger,
).lookup;
const dispatcher = new AutomationDispatcher({
  db,
  launcher,
  storage,
  logger,
  adapters,
  deferUnsupportedMs: config.automation.saleChecks.maxIntervalMs,
});

try {
  // Every feature's jobs (features.ts), so a new feature never edits this file.
  const { tasks, scheduledTasks, crontab, starts } = collectWorkerJobs(WORKER_FEATURES, {
    config,
    db,
    storage,
    ai: createAiClient(config.ai, {
      usageStore: new PostgresUsageStore(db),
      controls: new PostgresAiControls(db),
      quota: new PostgresQuotaPolicy(db),
      logger,
    }),
    connections,
    adapters,
    logger,
  });
  const worker = await startOperationWorker({
    connectionString: config.databaseUrl,
    db,
    adapters,
    tasks,
    logger,
    policy: scaledRetryPolicy(config.operationRetryDelayScale),
    concurrency: config.concurrency,
    taskConcurrency: config.taskConcurrency,
    scheduledTasks: [
      ...scheduledTasks,
      {
        name: AUTOMATION_DISPATCH_TASK,
        schedule: AUTOMATION_DISPATCH_SCHEDULE,
        run: () => dispatcher.dispatch(),
      },
    ],
    crontab,
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

  for (const start of starts) await start();

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
      fakeMarketplace: config.marketplaces.fakeMarketplaceUrl !== undefined,
      ebay: config.marketplaces.ebay?.environment ?? null,
      tokenVault: config.marketplaces.tokenVault?.driver ?? null,
      ebayNotifications: config.marketplaces.ebay?.notifications !== undefined,
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

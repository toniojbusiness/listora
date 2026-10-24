import { createDatabase } from '@listora/db';
import { startOperationWorker } from '@listora/operations';
import { createLogger, handleShutdownSignals } from '@listora/shared';

import { createAdapters } from './adapters.ts';
import { loadWorkerConfig } from './config.ts';

const config = loadWorkerConfig();
const logger = createLogger({ service: 'worker', level: config.logLevel });
const db = createDatabase({ connectionString: config.databaseUrl, max: config.concurrency + 5 });

try {
  const worker = await startOperationWorker({
    connectionString: config.databaseUrl,
    db,
    adapters: createAdapters(config),
    logger,
    concurrency: config.concurrency,
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
    { poolId: worker.poolId, fakeMarketplace: config.fakeMarketplaceUrl !== undefined },
    'worker ready',
  );
} catch (error) {
  logger.fatal({ err: error }, 'worker failed to start');
  await db.destroy();
  process.exitCode = 1;
}

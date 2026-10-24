import { createDatabase, createPool } from '@listora/db';
import { createLogger, handleShutdownSignals } from '@listora/shared';
import { createStorage } from '@listora/storage';

import { buildApp } from './app.ts';
import { createAuthDriver } from './auth/create-driver.ts';
import { loadApiConfig } from './config.ts';
import { pingDatabase } from './db.ts';
import { unscheduledPhotoJobs } from './photos/jobs.ts';

const config = loadApiConfig();
const logger = createLogger({ service: 'api', level: config.logLevel });
const pool = createPool({ connectionString: config.databaseUrl });
const db = createDatabase(pool);

const app = buildApp({
  logger,
  db,
  auth: createAuthDriver(config.auth, logger),
  storage: createStorage(config.storage),
  photoJobs: unscheduledPhotoJobs(logger),
  pingDatabase: () => pingDatabase(pool),
});

// SIGTERM (ECS) or SIGINT: stop accepting connections, let in-flight requests finish, then
// close the database pool.
handleShutdownSignals({
  logger,
  shutdown: async () => {
    await app.close();
    await db.destroy();
  },
});

await app.listen({ host: config.host, port: config.port });

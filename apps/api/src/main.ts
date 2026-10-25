import {
  createAiClient,
  PostgresAiControls,
  PostgresQuotaPolicy,
  PostgresUsageStore,
} from '@listora/ai';
import { graphileAnalysisJobs } from '@listora/analysis';
import { createOAuthClients, createTokenVault, sealOnly } from '@listora/connections';
import { createDatabase, createPool } from '@listora/db';
import { createMarketplaceAdapters } from '@listora/marketplaces';
import { graphilePhotoJobs } from '@listora/photos';
import { createLogger, handleShutdownSignals } from '@listora/shared';
import { createStorage } from '@listora/storage';

import { buildApp } from './app.ts';
import { createAuthDriver } from './auth/create-driver.ts';
import { loadApiConfig } from './config.ts';
import { pingDatabase } from './db.ts';

const config = loadApiConfig();
const logger = createLogger({ service: 'api', level: config.logLevel });
const pool = createPool({ connectionString: config.databaseUrl });
const db = createDatabase(pool);

const app = buildApp({
  logger,
  db,
  auth: createAuthDriver(config.auth, logger),
  storage: createStorage(config.storage),
  photoJobs: graphilePhotoJobs,
  ai: createAiClient(config.ai, {
    usageStore: new PostgresUsageStore(db),
    controls: new PostgresAiControls(db),
    quota: new PostgresQuotaPolicy(db),
    logger,
  }),
  analysisJobs: graphileAnalysisJobs,
  connections: {
    adapters: createMarketplaceAdapters(config.marketplaces),
    oauth: createOAuthClients(config.marketplaces),
    // The API only seals new grants; the worker opens them at use time.
    sealer:
      config.marketplaces.tokenVault === undefined
        ? undefined
        : sealOnly(createTokenVault(config.marketplaces.tokenVault)),
  },
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

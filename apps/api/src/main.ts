import { createLogger, handleShutdownSignals } from '@listora/shared';

import { buildApp } from './app.ts';
import { loadApiConfig } from './config.ts';
import { createDatabasePool, pingDatabase } from './db.ts';

const config = loadApiConfig();
const logger = createLogger({ service: 'api', level: config.logLevel });
const pool = createDatabasePool({ connectionString: config.databaseUrl });
const app = buildApp({ logger, pingDatabase: () => pingDatabase(pool) });

handleShutdownSignals({
  logger,
  shutdown: async () => {
    await app.close();
    await pool.end();
  },
});

await app.listen({ host: config.host, port: config.port });

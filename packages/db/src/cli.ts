/**
 * Schema migration command: `npm run db:migrate -- [latest | up | status | down <name>]`.
 * Reads DATABASE_URL (see `.env.example`) and logs one JSON line per result. `latest` and `up`
 * also install or upgrade the job queue schema (see job-queue.ts), which has no `down`.
 */
import { assertNever, createLogger } from '@listora/shared';

import { loadMigrateConfig } from './config.ts';
import { createDatabase } from './database.ts';
import { JOB_QUEUE_SCHEMA, migrateJobQueue } from './job-queue.ts';
import { SchemaMigrator } from './migrations.ts';

const config = loadMigrateConfig(process.argv.slice(2));
const logger = createLogger({ service: 'db-migrate', level: config.logLevel });
const db = createDatabase({ connectionString: config.databaseUrl, max: 1 });
const migrator = new SchemaMigrator(db);

async function run(): Promise<void> {
  switch (config.command) {
    case 'latest':
    case 'up': {
      const applied =
        config.command === 'latest' ? await migrator.migrateToLatest() : await migrator.migrateUp();
      logger.info({ applied }, applied.length > 0 ? 'migrations applied' : 'schema is up to date');
      await migrateJobQueue({ connectionString: config.databaseUrl, logger });
      logger.info({ schema: JOB_QUEUE_SCHEMA }, 'job queue schema is up to date');
      return;
    }
    case 'down': {
      // Reverting can drop tables and data, so the caller names the migration to revert.
      const latest = (await migrator.status()).findLast((migration) => migration.executedAt);
      if (latest?.name !== config.target) {
        throw new Error(
          `Refusing to revert: the latest applied migration is ${latest?.name ?? '(none)'}, not ${String(config.target)}`,
        );
      }
      logger.info({ reverted: await migrator.migrateDown() }, 'migration reverted');
      return;
    }
    case 'status':
      for (const migration of await migrator.status()) {
        logger.info(
          { migration: migration.name, executedAt: migration.executedAt },
          migration.executedAt ? 'applied' : 'pending',
        );
      }
      return;
    default:
      assertNever(config.command);
  }
}

try {
  await run();
} catch (error) {
  logger.error({ err: error }, 'migration command failed');
  process.exitCode = 1;
} finally {
  await db.destroy();
}

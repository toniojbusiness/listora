import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql, type Kysely } from 'kysely';
import {
  Migrator,
  NO_MIGRATIONS,
  type Migration,
  type MigrationProvider,
  type MigrationResult,
  type MigrationResultSet,
} from 'kysely/migration';

import type { Db } from './database.ts';

/** Directory holding the plain SQL migrations shipped with this package. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/**
 * `20261024153000_add_sales.up.sql` and `20261024153000_add_sales.down.sql` form the migration
 * `20261024153000_add_sales`. The prefix is a UTC timestamp (`YYYYMMDDHHMMSS`), so branches
 * written in parallel never pick the same name. The first migrations, `0001` to `0014`, have
 * four-digit numbers instead and sort before every timestamp.
 */
const MIGRATION_FILE = /^((?:\d{4}|\d{14})_[a-z0-9_]+)\.(up|down)\.sql$/;

/**
 * Reads plain SQL migrations from a directory. Every migration is a pair of files,
 * `<prefix>_name.up.sql` and `<prefix>_name.down.sql`, whose prefix is a UTC timestamp
 * (`YYYYMMDDHHMMSS`) or, for the first migrations, a four-digit number. Any other file, an
 * unpaired one, a timestamp that is not a real UTC time, or two migrations with one prefix is
 * an error, so a typo can never silently skip a migration. Each file runs as one
 * multi-statement query.
 */
export class SqlFileMigrationProvider implements MigrationProvider {
  readonly #directory: string;

  constructor(directory: string = MIGRATIONS_DIR) {
    this.#directory = directory;
  }

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = new Map<string, { up?: string; down?: string }>();
    for (const file of await readdir(this.#directory)) {
      const match = MIGRATION_FILE.exec(file);
      const name = match?.[1];
      const direction = match?.[2];
      if (name === undefined || (direction !== 'up' && direction !== 'down')) {
        throw new Error(
          `Unexpected file ${file} in ${this.#directory}: migrations are YYYYMMDDHHMMSS_name.up.sql and YYYYMMDDHHMMSS_name.down.sql`,
        );
      }
      const pair = files.get(name) ?? {};
      pair[direction] = join(this.#directory, file);
      files.set(name, pair);
    }

    const prefixes = new Map<string, string>();
    const migrations: Record<string, Migration> = {};
    for (const [name, { up, down }] of files) {
      if (up === undefined || down === undefined) {
        throw new Error(`Migration ${name} needs both ${name}.up.sql and ${name}.down.sql`);
      }
      const prefix = migrationPrefix(name);
      if (prefix.length === 14 && !isUtcTimestamp(prefix)) {
        throw new Error(`Migration ${name} does not start with a UTC time (YYYYMMDDHHMMSS)`);
      }
      const clash = prefixes.get(prefix);
      if (clash !== undefined) {
        throw new Error(`Migrations ${clash} and ${name} share the prefix ${prefix}`);
      }
      prefixes.set(prefix, name);
      migrations[name] = {
        up: async (db) => runSqlFile(db, up),
        down: async (db) => runSqlFile(db, down),
      };
    }
    return migrations;
  }
}

/** The number or timestamp a migration name starts with. */
export function migrationPrefix(name: string): string {
  return name.slice(0, name.indexOf('_'));
}

/** Whether `YYYYMMDDHHMMSS` names a real UTC time (no 13th month or 25th hour). */
function isUtcTimestamp(prefix: string): boolean {
  const parts = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(prefix)?.slice(1).map(Number);
  if (parts === undefined) return false;
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = parts;
  const time = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    time.getUTCFullYear() === year &&
    time.getUTCMonth() === month - 1 &&
    time.getUTCDate() === day &&
    time.getUTCHours() === hour &&
    time.getUTCMinutes() === minute &&
    time.getUTCSeconds() === second
  );
}

async function runSqlFile(db: Kysely<unknown>, path: string): Promise<void> {
  // A query without parameters uses Postgres's simple protocol, which accepts many statements.
  await sql.raw(await readFile(path, 'utf8')).execute(db);
}

export class MigrationError extends Error {
  readonly results: readonly MigrationResult[];

  constructor(action: string, resultSet: MigrationResultSet) {
    const failed = resultSet.results?.find((result) => result.status === 'Error');
    const reason =
      resultSet.error instanceof Error ? resultSet.error.message : String(resultSet.error);
    super(
      failed === undefined
        ? `${action} failed: ${reason}`
        : `${action} failed in ${failed.migrationName} (${failed.direction.toLowerCase()}): ${reason}`,
      { cause: resultSet.error },
    );
    this.name = 'MigrationError';
    this.results = resultSet.results ?? [];
  }
}

export interface MigrationStatus {
  name: string;
  executedAt: Date | null;
}

/**
 * Runs the schema migrations. Migrations apply in name order inside one transaction per run
 * (Postgres has transactional DDL), so a failing migration leaves the schema unchanged. A
 * database lock stops two processes from migrating at once, and applying migrations out of
 * order is refused.
 */
export class SchemaMigrator {
  readonly #migrator: Migrator;

  constructor(db: Db, provider: MigrationProvider = new SqlFileMigrationProvider()) {
    this.#migrator = new Migrator({ db, provider });
  }

  /** Applies every pending migration; returns the names applied. */
  async migrateToLatest(): Promise<string[]> {
    return this.#run('migrate to latest', this.#migrator.migrateToLatest());
  }

  /** Applies the next pending migration, if any. */
  async migrateUp(): Promise<string[]> {
    return this.#run('migrate up', this.#migrator.migrateUp());
  }

  /** Reverts the most recently applied migration, if any. */
  async migrateDown(): Promise<string[]> {
    return this.#run('migrate down', this.#migrator.migrateDown());
  }

  /** Reverts every applied migration, leaving an empty schema. */
  async migrateToEmpty(): Promise<string[]> {
    return this.#run('migrate to empty', this.#migrator.migrateTo(NO_MIGRATIONS));
  }

  async status(): Promise<MigrationStatus[]> {
    const migrations = await this.#migrator.getMigrations();
    return migrations.map((migration) => ({
      name: migration.name,
      executedAt: migration.executedAt ?? null,
    }));
  }

  async #run(action: string, pending: Promise<MigrationResultSet>): Promise<string[]> {
    const resultSet = await pending;
    if (resultSet.error !== undefined) throw new MigrationError(action, resultSet);
    return (resultSet.results ?? []).map((result) => result.migrationName);
  }
}

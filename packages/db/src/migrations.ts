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

/** `0001_schema_v1.up.sql` and `0001_schema_v1.down.sql` form the migration `0001_schema_v1`. */
const MIGRATION_FILE = /^(\d{4}_[a-z0-9_]+)\.(up|down)\.sql$/;

/**
 * Reads plain SQL migrations from a directory. Every migration is a numbered pair of files,
 * `NNNN_name.up.sql` and `NNNN_name.down.sql`; any other file, or an unpaired one, is an error
 * so a typo can never silently skip a migration. Each file runs as one multi-statement query.
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
          `Unexpected file ${file} in ${this.#directory}: migrations are NNNN_name.up.sql and NNNN_name.down.sql`,
        );
      }
      const pair = files.get(name) ?? {};
      pair[direction] = join(this.#directory, file);
      files.set(name, pair);
    }

    const numbers = new Map<string, string>();
    const migrations: Record<string, Migration> = {};
    for (const [name, { up, down }] of files) {
      if (up === undefined || down === undefined) {
        throw new Error(`Migration ${name} needs both ${name}.up.sql and ${name}.down.sql`);
      }
      const number = name.slice(0, 4);
      const clash = numbers.get(number);
      if (clash !== undefined) {
        throw new Error(`Migrations ${clash} and ${name} share the number ${number}`);
      }
      numbers.set(number, name);
      migrations[name] = {
        up: async (db) => runSqlFile(db, up),
        down: async (db) => runSqlFile(db, down),
      };
    }
    return migrations;
  }
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

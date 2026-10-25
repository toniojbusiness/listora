import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MIGRATIONS_DIR, migrationPrefix, SqlFileMigrationProvider } from './migrations.ts';

const directories: string[] = [];

async function migrationsDir(files: readonly string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'listora-migrations-'));
  directories.push(directory);
  for (const file of files) await writeFile(join(directory, file), 'select 1;');
  return directory;
}

/** The last migration named with a four-digit number; every later one has a UTC timestamp. */
const LAST_NUMBERED_MIGRATION = '0013_trust_metric_indexes';

/**
 * Problems with the shipped migration names: a prefix used twice, or a numbered migration
 * added after the switch to timestamps. Timestamps never collide between parallel branches,
 * and gaps between numbers or times are allowed.
 */
function namingProblems(files: readonly string[]): string[] {
  const owners = new Map<string, string>();
  const problems: string[] = [];
  for (const name of [...new Set(files.map((file) => file.split('.')[0] ?? file))].sort()) {
    const prefix = migrationPrefix(name);
    const owner = owners.get(prefix);
    if (owner === undefined) owners.set(prefix, name);
    else problems.push(`${prefix} is used by ${owner} and ${name}`);
    if (prefix.length === 4 && name > LAST_NUMBERED_MIGRATION) {
      problems.push(`${name} needs a UTC timestamp name (YYYYMMDDHHMMSS_name)`);
    }
  }
  return problems;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});

describe('SqlFileMigrationProvider', () => {
  it('pairs up and down files into named migrations', async () => {
    const directory = await migrationsDir([
      '0002_second.down.sql',
      '0001_first.up.sql',
      '0002_second.up.sql',
      '0001_first.down.sql',
    ]);
    const migrations = await new SqlFileMigrationProvider(directory).getMigrations();
    expect(Object.keys(migrations).sort()).toEqual(['0001_first', '0002_second']);
  });

  it('rejects a migration without its down file', async () => {
    const directory = await migrationsDir(['0001_first.up.sql']);
    await expect(new SqlFileMigrationProvider(directory).getMigrations()).rejects.toThrow(
      'Migration 0001_first needs both 0001_first.up.sql and 0001_first.down.sql',
    );
  });

  it('rejects files that do not follow the naming scheme', async () => {
    const directory = await migrationsDir(['0001_first.up.sql', '0001_first.down.sql', '1_x.sql']);
    await expect(new SqlFileMigrationProvider(directory).getMigrations()).rejects.toThrow(
      /Unexpected file 1_x\.sql/,
    );
  });

  it('rejects two migrations with the same number', async () => {
    const directory = await migrationsDir([
      '0001_first.up.sql',
      '0001_first.down.sql',
      '0001_other.up.sql',
      '0001_other.down.sql',
    ]);
    await expect(new SqlFileMigrationProvider(directory).getMigrations()).rejects.toThrow(
      'Migrations 0001_first and 0001_other share the prefix 0001',
    );
  });

  it('rejects two migrations with the same timestamp', async () => {
    const directory = await migrationsDir([
      '20261024153000_a.up.sql',
      '20261024153000_a.down.sql',
      '20261024153000_b.up.sql',
      '20261024153000_b.down.sql',
    ]);
    await expect(new SqlFileMigrationProvider(directory).getMigrations()).rejects.toThrow(
      'Migrations 20261024153000_a and 20261024153000_b share the prefix 20261024153000',
    );
  });

  it.each(['20261324153000', '20261024250000', '20260230120000', '20261024156000'])(
    'rejects %s, which is not a real UTC time',
    async (prefix) => {
      const directory = await migrationsDir([`${prefix}_a.up.sql`, `${prefix}_a.down.sql`]);
      await expect(new SqlFileMigrationProvider(directory).getMigrations()).rejects.toThrow(
        `Migration ${prefix}_a does not start with a UTC time (YYYYMMDDHHMMSS)`,
      );
    },
  );

  it.each(['202610241530_a.up.sql', '2026102415300000_a.up.sql', '20261024T153000_a.up.sql'])(
    'rejects %s, whose prefix is neither a number nor a timestamp',
    async (file) => {
      const directory = await migrationsDir([file]);
      await expect(new SqlFileMigrationProvider(directory).getMigrations()).rejects.toThrow(
        /Unexpected file .*YYYYMMDDHHMMSS_name\.up\.sql/,
      );
    },
  );

  it('orders numbered migrations before timestamped ones, and timestamps by time', async () => {
    const directory = await migrationsDir([
      '20261101090000_later.up.sql',
      '20261101090000_later.down.sql',
      '0012_numbered.up.sql',
      '0012_numbered.down.sql',
      '20261024153000_earlier.up.sql',
      '20261024153000_earlier.down.sql',
    ]);
    const migrations = await new SqlFileMigrationProvider(directory).getMigrations();
    // Kysely's migrator runs migrations in name order.
    expect(Object.keys(migrations).sort()).toEqual([
      '0012_numbered',
      '20261024153000_earlier',
      '20261101090000_later',
    ]);
  });

  it('ships migrations with unique prefixes, and timestamps after the numbered ones', async () => {
    // A reused prefix, or a new four-digit number, fails here.
    expect(namingProblems(await readdir(MIGRATIONS_DIR))).toEqual([]);
  });

  it('naming check reports shared prefixes and new numbers, and allows gaps', () => {
    const pair = (name: string) => [`${name}.up.sql`, `${name}.down.sql`];
    expect(namingProblems([...pair('0001_a'), ...pair('0003_c')])).toEqual([]);
    expect(
      namingProblems([...pair('0013_trust_metric_indexes'), ...pair('20261024153000_a')]),
    ).toEqual([]);
    expect(namingProblems([...pair('0001_a'), ...pair('0002_b'), ...pair('0002_c')])).toEqual([
      '0002 is used by 0002_b and 0002_c',
    ]);
    expect(namingProblems([...pair('20261024153000_a'), ...pair('20261024153000_b')])).toEqual([
      '20261024153000 is used by 20261024153000_a and 20261024153000_b',
    ]);
    expect(namingProblems(pair('0014_new'))).toEqual([
      '0014_new needs a UTC timestamp name (YYYYMMDDHHMMSS_name)',
    ]);
  });

  it('loads the migrations shipped with this package', async () => {
    const files = await readdir(MIGRATIONS_DIR);
    const migrations = await new SqlFileMigrationProvider().getMigrations();
    expect(Object.keys(migrations)).toContain('0001_schema_v1');
    expect(Object.keys(migrations)).toHaveLength(files.length / 2);
  });
});

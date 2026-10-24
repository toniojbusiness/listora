import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MIGRATIONS_DIR, SqlFileMigrationProvider } from './migrations.ts';

const directories: string[] = [];

async function migrationsDir(files: readonly string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'listora-migrations-'));
  directories.push(directory);
  for (const file of files) await writeFile(join(directory, file), 'select 1;');
  return directory;
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
      'Migrations 0001_first and 0001_other share the number 0001',
    );
  });

  it('loads the migrations shipped with this package', async () => {
    const files = await readdir(MIGRATIONS_DIR);
    const migrations = await new SqlFileMigrationProvider().getMigrations();
    expect(Object.keys(migrations)).toContain('0001_schema_v1');
    expect(Object.keys(migrations)).toHaveLength(files.length / 2);
  });
});

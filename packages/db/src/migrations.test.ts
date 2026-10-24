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

/**
 * Numbers used by more than one migration. Gaps are allowed: firstmate pre-assigns numbers to
 * open branches and merges them in order.
 */
function numberingProblems(files: readonly string[]): string[] {
  const owners = new Map<string, string>();
  const problems: string[] = [];
  for (const name of [...new Set(files.map((file) => file.split('.')[0] ?? file))].sort()) {
    const number = name.slice(0, 4);
    const owner = owners.get(number);
    if (owner === undefined) owners.set(number, name);
    else problems.push(`${number} is used by ${owner} and ${name}`);
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
      'Migrations 0001_first and 0001_other share the number 0001',
    );
  });

  it('ships migrations with unique numbers (gaps allowed)', async () => {
    // Numbers are assigned up front and branches merge in numeric order, so a gap is only a
    // migration that has not merged yet. A reused number fails here.
    expect(numberingProblems(await readdir(MIGRATIONS_DIR))).toEqual([]);
  });

  it('numbering check reports shared numbers and allows gaps', () => {
    const pair = (name: string) => [`${name}.up.sql`, `${name}.down.sql`];
    expect(numberingProblems([...pair('0001_a'), ...pair('0002_b')])).toEqual([]);
    expect(numberingProblems([...pair('0001_a'), ...pair('0003_c')])).toEqual([]);
    expect(numberingProblems(pair('0002_b'))).toEqual([]);
    expect(numberingProblems([...pair('0001_a'), ...pair('0002_b'), ...pair('0002_c')])).toEqual([
      '0002 is used by 0002_b and 0002_c',
    ]);
  });

  it('loads the migrations shipped with this package', async () => {
    const files = await readdir(MIGRATIONS_DIR);
    const migrations = await new SqlFileMigrationProvider().getMigrations();
    expect(Object.keys(migrations)).toContain('0001_schema_v1');
    expect(Object.keys(migrations)).toHaveLength(files.length / 2);
  });
});

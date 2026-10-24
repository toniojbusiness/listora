import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createScratchDatabase, startNodeProcess, type ScratchDatabase } from '@listora/testing';

const entry = fileURLToPath(new URL('cli.ts', import.meta.url));

/** Runs the real migrate command (`node src/cli.ts ...`) to completion. */
async function migrate(env: NodeJS.ProcessEnv, ...args: string[]) {
  const process_ = startNodeProcess(entry, { PATH: process.env['PATH'], ...env }, args);
  const code = await process_.waitForExit(20_000);
  return { code, logs: process_.logs, stderr: process_.stderr };
}

describe('migrate command (real Postgres)', () => {
  let scratch: ScratchDatabase;

  beforeEach(async () => {
    scratch = await createScratchDatabase('cli');
  });

  afterEach(async () => {
    await scratch.drop();
  });

  it('applies, reports, and reverts migrations', async () => {
    const env = { DATABASE_URL: scratch.url };

    const applied = await migrate(env, 'latest');
    expect(applied.code).toBe(0);
    expect(applied.logs).toContainEqual(
      expect.objectContaining({
        msg: 'migrations applied',
        applied: ['0001_schema_v1', '0002_ai_metering', '0003_ai_controls'],
      }),
    );

    const again = await migrate(env);
    expect(again.code).toBe(0);
    expect(again.logs).toContainEqual(expect.objectContaining({ msg: 'schema is up to date' }));

    const status = await migrate(env, 'status');
    expect(status.code).toBe(0);
    for (const migration of ['0001_schema_v1', '0002_ai_metering', '0003_ai_controls']) {
      expect(status.logs).toContainEqual(expect.objectContaining({ msg: 'applied', migration }));
    }

    const reverted = await migrate(env, 'down', '0003_ai_controls');
    expect(reverted.code).toBe(0);
    expect(reverted.logs).toContainEqual(
      expect.objectContaining({ msg: 'migration reverted', reverted: ['0003_ai_controls'] }),
    );
    const pending = await migrate(env, 'status');
    expect(pending.logs).toContainEqual(
      expect.objectContaining({ msg: 'applied', migration: '0002_ai_metering' }),
    );
    expect(pending.logs).toContainEqual(
      expect.objectContaining({ msg: 'pending', migration: '0003_ai_controls' }),
    );
  });

  it('refuses to revert a migration that is not the latest applied one', async () => {
    const env = { DATABASE_URL: scratch.url };
    expect((await migrate(env)).code).toBe(0);

    const refused = await migrate(env, 'down', '0000_wrong');
    expect(refused.code).toBe(1);
    const failure = refused.logs.find((line) => line['msg'] === 'migration command failed');
    expect(failure?.['err']).toMatchObject({
      message:
        'Refusing to revert: the latest applied migration is 0003_ai_controls, not 0000_wrong',
    });
    expect((await migrate(env, 'status')).logs).toContainEqual(
      expect.objectContaining({ msg: 'applied', migration: '0003_ai_controls' }),
    );
  });

  it('exits non-zero when the database is unreachable', async () => {
    const result = await migrate({ DATABASE_URL: 'postgres://listora@127.0.0.1:1/listora_test' });
    expect(result.code).toBe(1);
    expect(result.logs).toContainEqual(
      expect.objectContaining({ msg: 'migration command failed' }),
    );
  });

  it('refuses to start without DATABASE_URL', async () => {
    const result = await migrate({});
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DATABASE_URL is required');
  });
});

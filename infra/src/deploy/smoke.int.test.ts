import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createScratchDatabase,
  startNodeProcess,
  type ScratchDatabase,
  type StartedProcess,
} from '@listora/testing';

import { MIGRATE_COMMAND } from '../containers.ts';
import { runSmoke } from './smoke.ts';

const apiEntry = fileURLToPath(new URL('../../../apps/api/src/main.ts', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));

// The post-deploy smoke test against the real API process and Postgres, signing in with the dev
// driver the way it does against a deployed API, except that the code comes from the process
// log instead of CloudWatch.
describe('post-deploy smoke test (real API process)', () => {
  let scratch: ScratchDatabase;
  let api: StartedProcess;
  let baseUrl: string;

  beforeAll(async () => {
    scratch = await createScratchDatabase('deploy_smoke');
    // The migration task's command (infra/src/containers.ts), which also installs the job queue.
    const [command = 'node', ...args] = MIGRATE_COMMAND;
    const migrated = spawnSync(command, args, {
      cwd: repositoryRoot,
      env: { PATH: process.env['PATH'], DATABASE_URL: scratch.url, LOG_LEVEL: 'warn' },
      encoding: 'utf8',
    });
    expect(migrated.status, migrated.stderr + migrated.stdout).toBe(0);
    api = startNodeProcess(apiEntry, {
      PATH: process.env['PATH'],
      API_HOST: '127.0.0.1',
      API_PORT: '0',
      DATABASE_URL: scratch.url,
      AUTH_DRIVER: 'dev',
      AUTH_DEV_SECRET: 'smoke-test-secret-at-least-32-characters',
      LOG_LEVEL: 'info',
    });
    const listening = await api.waitForLog(
      (line) => typeof line['msg'] === 'string' && line['msg'].startsWith('Server listening at '),
      20_000,
    );
    baseUrl = String(listening['msg']).replace('Server listening at ', '');
  });

  afterAll(async () => {
    await api.stop();
    await scratch.drop();
  });

  it('passes against a healthy API and leaves no account or item behind', async () => {
    const lines: string[] = [];
    await runSmoke({
      apiUrl: `${baseUrl}/`,
      auth: {
        driver: 'dev',
        readCode: async (email) =>
          String(
            (await api.waitForLog((line) => line['email'] === email && 'devSignInCode' in line))[
              'devSignInCode'
            ],
          ),
      },
      log: (line) => lines.push(line),
    });
    expect(lines.at(-1)).toBe('smoke: ok');
    expect(lines.join('\n')).toMatch(/created draft item [A-Z]+-0+1\n.*deleted item/s);
    expect(lines).toContain('smoke: deleted the smoke account');

    const client = new pg.Client({ connectionString: scratch.url });
    await client.connect();
    try {
      const counts = await client.query<{ accounts: string; items: string }>(
        'select (select count(*) from account) as accounts, (select count(*) from inventory_item) as items',
      );
      expect(counts.rows[0]).toEqual({ accounts: '0', items: '0' });
    } finally {
      await client.end();
    }
  });
});

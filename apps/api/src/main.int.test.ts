import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { startNodeProcess, testDatabaseUrl, type StartedProcess } from '@listora/testing';

const entry = fileURLToPath(new URL('main.ts', import.meta.url));

/** Boots the real API process on an ephemeral port and returns its base URL. */
async function startApi(databaseUrl: string): Promise<{ api: StartedProcess; baseUrl: string }> {
  const api = startNodeProcess(entry, {
    PATH: process.env['PATH'],
    API_HOST: '127.0.0.1',
    API_PORT: '0',
    DATABASE_URL: databaseUrl,
    LOG_LEVEL: 'info',
  });
  const listening = await api.waitForLog(
    (line) => typeof line['msg'] === 'string' && line['msg'].startsWith('Server listening at '),
  );
  const baseUrl = String(listening['msg']).replace('Server listening at ', '');
  return { api, baseUrl };
}

describe('api process (real Postgres)', () => {
  let api: StartedProcess | undefined;

  afterEach(async () => {
    await api?.stop();
    api = undefined;
  });

  it('serves liveness and readiness end to end, then shuts down cleanly', async () => {
    const started = await startApi(testDatabaseUrl());
    api = started.api;

    const live = await fetch(`${started.baseUrl}/health/live`);
    expect(live.status).toBe(200);

    const ready = await fetch(`${started.baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });

    expect(await started.api.stop('SIGTERM')).toBe(0);
    api = undefined;
  });

  it('stays live but reports not ready when the database is unreachable', async () => {
    const started = await startApi('postgres://listora@127.0.0.1:1/listora_test');
    api = started.api;

    expect((await fetch(`${started.baseUrl}/health/live`)).status).toBe(200);
    expect((await fetch(`${started.baseUrl}/health/ready`)).status).toBe(503);
  });

  it('refuses to start without DATABASE_URL', async () => {
    api = startNodeProcess(entry, { PATH: process.env['PATH'] });

    expect(await api.waitForExit()).toBe(1);
    expect(api.stderr).toContain('DATABASE_URL is required');
  });

  it('refuses to start with an invalid DATABASE_URL without echoing it', async () => {
    api = startNodeProcess(entry, {
      PATH: process.env['PATH'],
      DATABASE_URL: 'mysql://listora:hunter2-secret@127.0.0.1/listora',
    });

    expect(await api.waitForExit()).toBe(1);
    expect(api.stderr).toContain('DATABASE_URL must be a postgres:// URL');
    expect(api.stderr).not.toContain('hunter2-secret');
  });
});

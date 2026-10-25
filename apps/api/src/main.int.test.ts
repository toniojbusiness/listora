import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, SchemaMigrator } from '@listora/db';
import {
  createScratchDatabase,
  startNodeProcess,
  type ScratchDatabase,
  type StartedProcess,
} from '@listora/testing';

const entry = fileURLToPath(new URL('main.ts', import.meta.url));
const DEV_SECRET = 'process-test-secret-at-least-32-characters';

/** Boots the real API process on an ephemeral port and returns its base URL. */
async function startApi(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ api: StartedProcess; baseUrl: string }> {
  const api = startNodeProcess(entry, {
    PATH: process.env['PATH'],
    API_HOST: '127.0.0.1',
    API_PORT: '0',
    DATABASE_URL: databaseUrl,
    AUTH_DRIVER: 'dev',
    AUTH_DEV_SECRET: DEV_SECRET,
    LOG_LEVEL: 'info',
    ...env,
  });
  let listening: Awaited<ReturnType<StartedProcess['waitForLog']>>;
  try {
    // As long as the worker's process tests allow: a loaded machine starts Node slowly.
    listening = await api.waitForLog(
      (line) => typeof line['msg'] === 'string' && line['msg'].startsWith('Server listening at '),
      20_000,
    );
  } catch (error) {
    // The test never gets the process to stop, so a process that did not come up in time
    // must not outlive it.
    await api.stop('SIGKILL');
    throw error;
  }
  const baseUrl = String(listening['msg']).replace('Server listening at ', '');
  return { api, baseUrl };
}

/** Signs in through the dev endpoints, reading the one-time code from the process log. */
async function signIn(api: StartedProcess, baseUrl: string, email: string): Promise<string> {
  const post = (path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await post('/dev/auth/codes', { email })).status).toBe(202);
  const line = await api.waitForLog((log) => log['email'] === email && 'devSignInCode' in log);
  const session = await post('/dev/auth/sessions', { email, code: line['devSignInCode'] });
  expect(session.status).toBe(200);
  return ((await session.json()) as { accessToken: string }).accessToken;
}

describe('api process (real Postgres)', () => {
  let scratch: ScratchDatabase;
  let api: StartedProcess | undefined;

  beforeAll(async () => {
    scratch = await createScratchDatabase('api_process');
    const db = createDatabase({ connectionString: scratch.url, max: 2 });
    try {
      await new SchemaMigrator(db).migrateToLatest();
    } finally {
      await db.destroy();
    }
  });

  afterEach(async () => {
    await api?.stop();
    api = undefined;
  });

  afterAll(async () => {
    await scratch.drop();
  });

  it('serves liveness and readiness end to end, then shuts down cleanly', async () => {
    const started = await startApi(scratch.url);
    api = started.api;

    const live = await fetch(`${started.baseUrl}/health/live`);
    expect(live.status).toBe(200);

    const ready = await fetch(`${started.baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });

    expect(await started.api.stop('SIGTERM')).toBe(0);
    api = undefined;
  });

  it('signs in with a dev code and serves items, tagging every log line with the request id', async () => {
    const started = await startApi(scratch.url);
    api = started.api;
    const token = await signIn(api, started.baseUrl, 'process.user@example.com');

    const created = await fetch(`${started.baseUrl}/v1/items`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
        'x-request-id': 'support-ticket-42',
      },
      body: JSON.stringify({ details: { title: 'From the real process' } }),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('x-request-id')).toBe('support-ticket-42');
    const item = (await created.json()) as { id: string; sku: string };
    expect(item.sku).toBe('PU-000001');

    const missing = await fetch(`${started.baseUrl}/v1/items/${crypto.randomUUID()}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.status).toBe(404);
    const error = (await missing.json()) as { error: { requestId: string } };
    expect(error.error.requestId).toBe(missing.headers.get('x-request-id'));
    expect(error.error.requestId).toMatch(/^[0-9a-f-]{36}$/);

    await api.waitForLog(
      (line) => line['msg'] === 'request completed' && line['requestId'] === error.error.requestId,
    );
    const requestLines = api.logs.filter((line) => line['requestId'] === 'support-ticket-42');
    expect(requestLines.map((line) => line['msg'])).toEqual([
      'incoming request',
      'request completed',
    ]);
    // The bearer token never reaches the logs.
    expect(JSON.stringify(api.logs)).not.toContain(token);
  });

  it('finishes an in-flight request after SIGTERM, then exits 0', async () => {
    const started = await startApi(scratch.url);
    api = started.api;
    const email = 'slow.request@example.com';
    const token = await signIn(api, started.baseUrl, email);
    const createItem = () =>
      fetch(`${started.baseUrl}/v1/items`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({}),
      });
    expect((await createItem()).status).toBe(201);

    // Hold the account's SKU counter so the next create waits inside its transaction.
    const blocker = new pg.Client({ connectionString: scratch.url });
    await blocker.connect();
    try {
      await blocker.query('begin');
      await blocker.query(
        `select s.next_number from sku_sequence s
         join membership m on m.account_id = s.account_id
         join app_user u on u.id = m.user_id
         where u.email = $1 for update of s`,
        [email],
      );
      const inFlight = createItem();
      await waitUntil(async () => {
        const { rows } = await blocker.query<{ waiting: number }>(
          "select count(*)::int as waiting from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
        );
        return (rows[0]?.waiting ?? 0) > 0;
      });

      const exited = api.stop('SIGTERM');
      await api.waitForLog((line) => line['msg'] === 'shutting down');
      await blocker.query('commit');

      expect((await inFlight).status).toBe(201);
      expect(await exited).toBe(0);
      api = undefined;
    } finally {
      await blocker.end();
    }
  });

  it('stays live but reports not ready when the database is unreachable', async () => {
    const started = await startApi('postgres://listora@127.0.0.1:1/listora_test');
    api = started.api;

    expect((await fetch(`${started.baseUrl}/health/live`)).status).toBe(200);
    expect((await fetch(`${started.baseUrl}/health/ready`)).status).toBe(503);
  });

  it('warns that dev sessions end on restart when AUTH_DEV_SECRET is not set', async () => {
    const started = await startApi(scratch.url, { AUTH_DEV_SECRET: undefined });
    api = started.api;
    expect(api.logs).toContainEqual(
      expect.objectContaining({
        level: 40,
        msg: 'AUTH_DEV_SECRET is not set: dev sessions end when the API restarts',
      }),
    );
  });

  it('runs with AUTH_DRIVER=cognito without the dev sign-in endpoints', async () => {
    const started = await startApi(scratch.url, {
      AUTH_DRIVER: 'cognito',
      AUTH_DEV_SECRET: undefined,
      COGNITO_USER_POOL_ID: 'us-east-1_ProcessTest',
      COGNITO_CLIENT_IDS: 'processtestclient000000000',
    });
    api = started.api;
    expect((await fetch(`${started.baseUrl}/health/ready`)).status).toBe(200);
    const devCodes = await fetch(`${started.baseUrl}/dev/auth/codes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com' }),
    });
    expect(devCodes.status).toBe(404);
    // No token, so nothing is verified and Cognito is never contacted.
    expect((await fetch(`${started.baseUrl}/v1/items`)).status).toBe(401);
  });

  it('refuses to start with AUTH_DRIVER=cognito but no user pool', async () => {
    api = startNodeProcess(entry, {
      PATH: process.env['PATH'],
      AUTH_DRIVER: 'cognito',
      DATABASE_URL: scratch.url,
    });

    expect(await api.waitForExit()).toBe(1);
    expect(api.stderr).toContain('COGNITO_USER_POOL_ID is required when AUTH_DRIVER=cognito');
    expect(api.stderr).toContain('COGNITO_CLIENT_IDS is required when AUTH_DRIVER=cognito');
  });

  it('refuses to start without DATABASE_URL or AUTH_DRIVER', async () => {
    api = startNodeProcess(entry, { PATH: process.env['PATH'] });

    expect(await api.waitForExit()).toBe(1);
    expect(api.stderr).toContain('DATABASE_URL is required');
    expect(api.stderr).toContain('AUTH_DRIVER is required');
  });

  it('refuses to start with an invalid DATABASE_URL without echoing it', async () => {
    api = startNodeProcess(entry, {
      PATH: process.env['PATH'],
      AUTH_DRIVER: 'dev',
      DATABASE_URL: 'mysql://listora:hunter2-secret@127.0.0.1/listora',
    });

    expect(await api.waitForExit()).toBe(1);
    expect(api.stderr).toContain('DATABASE_URL must be a postgres:// URL');
    expect(api.stderr).not.toContain('hunter2-secret');
  });
});

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

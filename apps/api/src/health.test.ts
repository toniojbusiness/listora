import { createDatabase } from '@listora/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { offlinePhotoDependencies } from './test-support.ts';
import { buildApp, type AppDependencies } from './app.ts';

describe('health routes', () => {
  // Never connected: health routes reach the database only through `pingDatabase`.
  const db = createDatabase({ connectionString: 'postgres://listora@127.0.0.1:1/unused' });
  const auth: AppDependencies['auth'] = {
    provider: 'dev',
    verifyAccessToken: () => Promise.resolve(undefined),
  };
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('reports liveness without touching dependencies', async () => {
    app = buildApp({
      db,
      auth,
      ...offlinePhotoDependencies(),
      pingDatabase: () => Promise.reject(new Error('must not be called')),
    });
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports ready when the database answers', async () => {
    app = buildApp({
      db,
      auth,
      ...offlinePhotoDependencies(),
      pingDatabase: () => Promise.resolve(),
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  it('reports 503 without leaking error details when the database is down', async () => {
    app = buildApp({
      db,
      auth,
      ...offlinePhotoDependencies(),
      pingDatabase: () => Promise.reject(new Error('password authentication failed for hunter2')),
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'unavailable',
      checks: { database: 'unavailable' },
    });
    expect(response.body).not.toContain('hunter2');
  });
});

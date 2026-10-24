import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.ts';

describe('health routes', () => {
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('reports liveness without touching dependencies', async () => {
    app = buildApp({ pingDatabase: () => Promise.reject(new Error('must not be called')) });
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports ready when the database answers', async () => {
    app = buildApp({ pingDatabase: () => Promise.resolve() });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  it('reports 503 without leaking error details when the database is down', async () => {
    app = buildApp({
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

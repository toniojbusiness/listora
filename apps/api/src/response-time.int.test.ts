/**
 * The API's response time metric on a real app (response-time.ts): each contract operation's
 * response writes one `ApiResponseTime` value, and the long polls write none, so the latency
 * alarm never reads their waits.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMetricsEmitter } from '@listora/observability';

import { createTestApi, type TestApi } from './test-support.ts';

describe('ApiResponseTime (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  const lines: Record<string, unknown>[] = [];
  const timed = () => lines.filter((line) => 'ApiResponseTime' in line);

  beforeAll(async () => {
    api = await createTestApi('responsetime', {
      metrics: createMetricsEmitter({
        service: 'api',
        write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
      }),
    });
    token = await api.signIn('rosa-latency@example.com');
  });

  afterAll(async () => {
    await api.close();
  });

  it('times an operation of the app, and not a long poll or a health check', async () => {
    lines.length = 0;
    expect((await api.call('listItems', { token })).status).toBe(200);
    expect(timed()).toHaveLength(1);

    // A long poll's own wait: an item that isn't there answers at once, and is still not timed.
    await api.call('waitForItemChange', {
      token,
      params: { itemId: randomUUID() },
      query: { waitSeconds: 1 },
    });
    expect((await api.app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    expect(timed()).toHaveLength(1);
  });
});

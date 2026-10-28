/**
 * Compression on the real routes (compression.ts): an answer the app reads is compressed when it
 * asks and the answer is large enough, and never for a client that does not ask.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { COMPRESSION_OPT_IN_HEADER } from './compression.ts';
import { createTestApi, type TestApi } from './test-support.ts';

const APP_ACCEPT_ENCODING = 'gzip, deflate, br';

describe('response compression on the API routes (real Postgres)', () => {
  let api: TestApi;
  let token: string;

  beforeAll(async () => {
    api = await createTestApi('compression');
    token = await api.signIn('compression@example.com');
  });

  afterAll(async () => {
    await api.close();
  });

  it('sends the app, which does not ask, every answer as it is', async () => {
    const runtime = await api.call('getPhoneRuntime', {
      token,
      headers: { 'accept-encoding': APP_ACCEPT_ENCODING },
    });
    expect(runtime.status).toBe(200);
    expect(runtime.body.source?.length).toBeGreaterThan(100_000);
    expect(runtime.headers['content-encoding']).toBeUndefined();
  });

  it('compresses a large answer for a client that asks', async () => {
    for (let n = 0; n < 30; n += 1) {
      const created = await api.call('createItem', {
        token,
        body: { details: { title: `Levi's Trucker Denim Jacket ${String(n)}` } },
      });
      expect(created.status).toBe(201);
    }
    const page = await api.call('listItems', {
      token,
      headers: { 'accept-encoding': APP_ACCEPT_ENCODING, [COMPRESSION_OPT_IN_HEADER]: 'accepted' },
    });
    expect(page.status).toBe(200);
    expect(page.body.data.length).toBe(25);
    expect(page.headers['content-encoding']).toBe('br');
    expect(page.wireBytes * 2).toBeLessThan(JSON.stringify(page.body).length);
  });
});

/**
 * Request limits (rate-limits.ts, audit M4) on a real app: per account after sign-in, per
 * source address for every request, and a smaller budget per address for requests no sign-in
 * protects. Each refusal is `429 rate_limited` with `Retry-After`, and the budget refills.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from './test-support.ts';

const LIMITS = { perAddress: 40, publicPerAddress: 10, perAccount: 5 };

describe('request limits (real Postgres)', () => {
  let api: TestApi;
  let maria: string;
  let jo: string;

  beforeAll(async () => {
    api = await createTestApi('ratelimits', { rateLimits: LIMITS });
    maria = await api.signIn('maria-limits@example.com');
    jo = await api.signIn('jo-limits@example.com');
  });

  afterAll(async () => {
    await api.close();
  });

  const from = (address: string, url: string, token?: string) =>
    api.app.inject({
      method: 'GET',
      url,
      headers: {
        'x-forwarded-for': `10.9.9.9, ${address}`,
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
    });

  it('limits each account on its own, and refills over the minute', async () => {
    for (let index = 0; index < LIMITS.perAccount; index += 1) {
      expect((await api.call('listItems', { token: maria })).status).toBe(200);
    }
    const refused = await api.call('listItems', { token: maria });
    expect(refused.status).toBe(429);
    expect(refused.error).toMatchObject({ code: 'rate_limited', retryable: true });
    // One request's worth comes back every 60 / 5 = 12 seconds.
    expect(refused.error.retryAfterSeconds).toBe(12);
    // Another account from the same address is not held up.
    expect((await api.call('listItems', { token: jo })).status).toBe(200);
    // Logged once per run of refusals, never with the address.
    expect((await api.call('listItems', { token: maria })).status).toBe(429);
    const logged = api.logLines.filter((line) => line['msg'] === 'request rate limited');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ rateLimit: 'account' });
    expect(JSON.stringify(logged[0])).not.toContain('127.0.0.1');

    api.clock.now += 60_000;
    expect((await api.call('listItems', { token: maria })).status).toBe(200);
  });

  it('gives requests no sign-in protects a small budget per address', async () => {
    for (let index = 0; index < LIMITS.publicPerAddress; index += 1) {
      expect((await from('203.0.113.9', '/v1/no-such-thing')).statusCode).toBe(404);
    }
    const refused = await from('203.0.113.9', '/v1/no-such-thing');
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBe('6');
    expect(refused.json()).toMatchObject({ error: { code: 'rate_limited' } });
    // Another address, and the health checks, go on.
    expect((await from('203.0.113.10', '/v1/no-such-thing')).statusCode).toBe(404);
    expect((await from('203.0.113.9', '/health/live')).statusCode).toBe(200);
    // Only the nearest proxy's entry counts: a client cannot pick a fresh address.
    const spoofed = await api.app.inject({
      method: 'GET',
      url: '/v1/no-such-thing',
      headers: { 'x-forwarded-for': '198.18.0.1, 203.0.113.9' },
    });
    expect(spoofed.statusCode).toBe(429);
  });

  it('limits every request from one address, signed in or not', async () => {
    // Without a sign-in the guard answers 401, which still costs the address.
    for (let index = 0; index < LIMITS.perAddress; index += 1) {
      expect((await from('198.51.100.7', '/v1/items')).statusCode).toBe(401);
    }
    expect((await from('198.51.100.7', '/v1/items')).statusCode).toBe(429);
    // Refused before the guard, so even a signed-in request from there waits.
    expect((await from('198.51.100.7', '/v1/items', jo)).statusCode).toBe(429);
    expect((await from('198.51.100.8', '/v1/items', jo)).statusCode).toBe(200);
  });
});

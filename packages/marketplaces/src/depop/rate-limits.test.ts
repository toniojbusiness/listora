/**
 * Depop's rate limits on Listora's side (rate-limits.ts): sliding windows per seller and for the
 * application, and, against the fake Depop enforcing the same limits, a burst that slows down
 * instead of hitting a 429.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sampleListingContent } from '../testing.ts';
import { DepopAdapter } from './adapter.ts';
import { DepopApi } from './client.ts';
import { depopEndpoints, loadDepopConfig } from './config.ts';
import { FAKE_DEPOP_CLIENT_ID, FAKE_DEPOP_CLIENT_SECRET } from './fake/constants.ts';
import { FakeDepop } from './fake/fake-depop.ts';
import { DepopOAuthClient } from './oauth.ts';
import { DepopRateLimiter } from './rate-limits.ts';
import type { DepopSellerSource } from './seller.ts';
import { DepopSellerTokens, MemoryDepopTokenStore } from './tokens.ts';

const signal = new AbortController().signal;

describe('DepopRateLimiter', () => {
  function clock() {
    let now = 1_000_000;
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("holds a seller to Depop's listing-write and other allowances separately", async () => {
    const time = clock();
    const limiter = new DepopRateLimiter({
      seller: {
        listingWrite: { requests: 2, windowMs: 10_000 },
        other: { requests: 3, windowMs: 60_000 },
      },
      maxWaitMs: 0,
      now: time.now,
    });
    expect(await limiter.acquire('a', 'listing_write', signal)).toEqual({ ok: true });
    expect(await limiter.acquire('a', 'listing_write', signal)).toEqual({ ok: true });
    // Depop's 10 seconds, and a margin for the time the request takes to arrive.
    expect(await limiter.acquire('a', 'listing_write', signal)).toEqual({
      ok: false,
      retryAfterMs: 10_500,
    });
    // Other calls and other sellers have allowances of their own.
    expect(await limiter.acquire('a', 'other', signal)).toEqual({ ok: true });
    expect(await limiter.acquire('b', 'listing_write', signal)).toEqual({ ok: true });
    time.advance(10_499);
    expect(await limiter.acquire('a', 'listing_write', signal)).toEqual({
      ok: false,
      retryAfterMs: 1,
    });
    time.advance(1);
    expect(await limiter.acquire('a', 'listing_write', signal)).toEqual({ ok: true });
  });

  it('holds every seller together to the application allowance', async () => {
    const time = clock();
    const limiter = new DepopRateLimiter({ applicationPerMinute: 3, maxWaitMs: 0, now: time.now });
    for (const seller of ['a', 'b', 'c']) {
      expect(await limiter.acquire(seller, 'other', signal)).toEqual({ ok: true });
    }
    expect(await limiter.acquire('d', 'other', signal)).toEqual({
      ok: false,
      retryAfterMs: 61_000,
    });
  });

  it('waits for room up to its limit, and takes nothing when it gives up', async () => {
    const limiter = new DepopRateLimiter({
      seller: {
        listingWrite: { requests: 1, windowMs: 200 },
        other: { requests: 1, windowMs: 60_000 },
      },
      maxWaitMs: 500,
    });
    const started = Date.now();
    expect(await limiter.acquire('a', 'listing_write', signal)).toEqual({ ok: true });
    expect(await limiter.acquire('a', 'listing_write', signal)).toEqual({ ok: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(await limiter.acquire('a', 'other', signal)).toEqual({ ok: true });
    const refused = await limiter.acquire('a', 'other', signal);
    expect(refused).toMatchObject({ ok: false });
  });
});

describe('a burst of Depop listings under the fake Depop limits', () => {
  let fake: FakeDepop;
  /** Listora's allowance for the seller. */
  const limits = { requests: 4, windowMs: 1_000 };

  beforeEach(async () => {
    // The fake counts a request when its handler runs, in this process; under load that can lag
    // the send by more than the limiter's margin, so its window is a little shorter here.
    fake = await FakeDepop.start({ rateLimits: { listingWrite: { requests: 4, windowMs: 600 } } });
  });

  afterEach(async () => {
    expect(fake.specViolations).toEqual([]);
    await fake.close();
  });

  function adapter(maxWaitMs: number): DepopAdapter {
    const config = loadDepopConfig({
      DEPOP_ENV: 'fake',
      DEPOP_FAKE_URL: fake.url,
      DEPOP_USER_CONNECTION_ID: 'c',
    });
    if (config === undefined) throw new Error('config');
    const endpoints = depopEndpoints('fake', fake.url);
    const store = new MemoryDepopTokenStore();
    store.connect('c', {
      accessToken: '',
      accessExpiresAt: 0,
      // A grant of the development seller, whose address the fake configuration ships from.
      refreshToken: fake.grant(fake.developmentSellerId),
      grantExpiresAt: Date.now() + 60_000,
    });
    const tokens = new DepopSellerTokens({
      oauth: new DepopOAuthClient({
        tokenUrl: endpoints.oauthToken,
        authorizeUrl: endpoints.authorize,
        clientId: FAKE_DEPOP_CLIENT_ID,
        clientSecret: FAKE_DEPOP_CLIENT_SECRET,
      }),
      store,
    });
    const seller: DepopSellerSource = {
      accessToken: (connection, abort) => tokens.accessToken(connection, abort),
      forget: (connection, token) => {
        tokens.forget(connection, token);
      },
      listingSettings: () => config.listingSettings,
    };
    const api = new DepopApi({
      baseUrl: endpoints.api,
      seller,
      limiter: new DepopRateLimiter({
        seller: { listingWrite: limits, other: { requests: 100, windowMs: 1_000 } },
        maxWaitMs,
      }),
      timeoutMs: 5_000,
    });
    return new DepopAdapter({ api, seller });
  }

  const create = (depop: DepopAdapter, index: number) => {
    const content = sampleListingContent({ item: { category: 'clothing/tops/t_shirts' } });
    return depop.execute(
      {
        operationId: `op-${String(index)}`,
        kind: 'create',
        idempotencyKey: `key-${String(index)}`,
        attempt: 1,
        desired: { status: 'active' },
        listing: {
          listingId: `l-${String(index)}`,
          externalListingId: `AJ-000184-D${String(index + 1)}`,
          externalSku: null,
          externalUrl: null,
        },
        payload: depop.buildPayload(content.item, content.variant),
      },
      { signal, connection: { id: 'c', mode: 'api', status: 'connected' } },
    );
  };

  it('paces creates within the seller allowance: none is refused by Depop', async () => {
    const depop = adapter(5_000);
    const started = Date.now();
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, index) => create(depop, index)),
    );
    expect(outcomes.map((outcome) => outcome.type)).toEqual(outcomes.map(() => 'confirmed'));
    expect(fake.requests.filter((request) => request.status === 429)).toEqual([]);
    // Six creates at four a second take a second window.
    expect(Date.now() - started).toBeGreaterThanOrEqual(limits.windowMs - 20);
  });

  it('holds back what would wait too long, as a transient outcome that sent nothing', async () => {
    const depop = adapter(0);
    const before = fake.requests.length;
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, index) => create(depop, 20 + index)),
    );
    const held = outcomes.filter((outcome) => outcome.type === 'transient');
    expect(held.length).toBe(2);
    expect(held[0]).toMatchObject({
      code: 'rate_limited',
      retryAfterMs: expect.any(Number) as number,
    });
    // One token request and four creates reached Depop.
    expect(fake.requests.length - before).toBe(5);
    expect(fake.requests.filter((request) => request.status === 429)).toEqual([]);
  });
});

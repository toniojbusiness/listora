import { describe, expect, it } from 'vitest';

import { REDACTED_LOG_PATHS } from './logging.ts';
import { isSensitiveKey, REDACTED, redactForStorage, TRUNCATED } from './redact.ts';

describe('redactForStorage', () => {
  it('replaces credential-like keys at every depth', () => {
    const redacted = redactForStorage({
      accessToken: 'at-secret',
      request: {
        headers: { Authorization: 'Bearer secret', 'X-Api-Key': 'key-secret', accept: 'json' },
        body: { listing: { title: 'Jacket', nested: { deeper: { refresh_token: 'rt-secret' } } } },
      },
      attempts: [{ client_secret: 'cs-secret', status: 429 }],
    });

    expect(redacted).toEqual({
      accessToken: REDACTED,
      request: {
        headers: { Authorization: REDACTED, 'X-Api-Key': REDACTED, accept: 'json' },
        body: { listing: { title: 'Jacket', nested: { deeper: { refresh_token: REDACTED } } } },
      },
      attempts: [{ client_secret: REDACTED, status: 429 }],
    });
    expect(JSON.stringify(redacted)).not.toMatch(/(at|rt|cs|key)-secret|Bearer/);
  });

  it('covers every field name that log redaction removes', () => {
    const fields = new Set(REDACTED_LOG_PATHS.map((path) => path.split('.').at(-1) ?? path));
    for (const field of fields) expect(isSensitiveKey(field), field).toBe(true);
  });

  it('keeps ordinary listing fields', () => {
    for (const key of ['title', 'priceCents', 'status', 'externalListingId', 'sku', 'code']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it('cuts long strings, long arrays, and deep nesting', () => {
    const redacted = redactForStorage(
      { text: 'x'.repeat(20), list: [1, 2, 3, 4], deep: { a: { b: { c: 1 } } } },
      { maxStringLength: 5, maxArrayLength: 2, maxDepth: 3 },
    );
    expect(redacted).toEqual({
      text: `xxxxx${TRUNCATED}`,
      list: [1, 2, TRUNCATED],
      deep: { a: { b: TRUNCATED } },
    });
  });

  it('turns any value into plain JSON', () => {
    const when = new Date('2026-10-24T08:00:00.000Z');
    expect(
      redactForStorage({
        when,
        error: new TypeError('fetch failed'),
        big: 12n,
        nan: Number.NaN,
        skipped: undefined,
        fn: () => undefined,
        list: [undefined, null],
      }),
    ).toEqual({
      when: '2026-10-24T08:00:00.000Z',
      error: { name: 'TypeError', message: 'fetch failed' },
      big: '12',
      nan: null,
      list: [null, null],
    });
    expect(redactForStorage(undefined)).toBeNull();
  });
});

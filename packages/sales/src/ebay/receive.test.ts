import { describe, expect, it } from 'vitest';

import type { Db } from '@listora/db';
import type { SignatureVerdict } from '@listora/marketplaces';

import { receiveEbayNotification } from './receive.ts';

/** The paths that answer before touching the database. */
describe('receiveEbayNotification without storing', () => {
  const unusedDb = new Proxy({} as Db, {
    get: () => {
      throw new Error('the database must not be used');
    },
  });
  const quiet = { warn: () => undefined, error: () => undefined };
  const receive = (verdict: SignatureVerdict, body = '{}') =>
    receiveEbayNotification(
      { db: unusedDb, verifier: { verify: () => Promise.resolve(verdict) }, logger: quiet },
      { body, signature: 'header' },
      AbortSignal.timeout(1_000),
    );

  it('answers 503 when eBay cannot show its key, so eBay delivers again', async () => {
    expect(await receive({ type: 'unavailable', code: 'http_503' })).toEqual({
      status: 503,
      outcome: 'key_unavailable',
    });
  });

  it('answers 412 for a signature that does not verify', async () => {
    expect(await receive({ type: 'invalid', reason: 'bad_signature' })).toEqual({
      status: 412,
      outcome: 'rejected_signature',
    });
  });

  it('acknowledges a signed body it cannot read, so eBay stops resending it', async () => {
    expect(await receive({ type: 'valid' }, 'not json')).toEqual({
      status: 400,
      outcome: 'malformed',
    });
    expect(await receive({ type: 'valid' }, '{"metadata":{}}')).toEqual({
      status: 204,
      outcome: 'unreadable',
    });
  });
});

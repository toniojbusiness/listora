import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FAKE_EBAY_CLIENT_ID, FAKE_EBAY_CLIENT_SECRET } from './fake/constants.ts';
import { FakeEbay } from './fake/fake-ebay.ts';
import { decodeSignatureHeader, EbayNotificationVerifier } from './notification-signature.ts';
import { ApplicationToken, EbayOAuthClient } from './oauth.ts';

const ORDER = {
  user: { userId: 'fakeUser1', username: 'listora_dev_seller' },
  order: {
    orderId: '10-10000-20000',
    orderLineItems: [
      { orderLineItemId: '10-10000-20000-1', listingId: '110000000001', quantity: 1 },
    ],
  },
};

describe('EbayNotificationVerifier', () => {
  let fake: FakeEbay;
  let clock: number;

  beforeAll(async () => {
    fake = await FakeEbay.start();
  });

  afterAll(async () => {
    await fake.close();
  });

  afterEach(() => {
    fake.clearFaults();
  });

  const verifier = (options: { keyTtlMs?: number } = {}): EbayNotificationVerifier => {
    clock = Date.now();
    const oauth = new EbayOAuthClient({
      tokenUrl: `${fake.url}/identity/v1/oauth2/token`,
      clientId: FAKE_EBAY_CLIENT_ID,
      clientSecret: FAKE_EBAY_CLIENT_SECRET,
    });
    return new EbayNotificationVerifier({
      endpoints: { api: fake.url },
      token: new ApplicationToken(oauth),
      now: () => clock,
      ...options,
    });
  };
  const keyFetches = (): number =>
    fake.requests.filter((request) => request.action === 'public_key').length;
  const signal = (): AbortSignal => AbortSignal.timeout(5_000);

  it('accepts a notification eBay signed, and rejects one changed after signing', async () => {
    const subject = verifier();
    const notification = fake.notification('ORDER_CONFIRMATION', ORDER);
    expect(await subject.verify(notification.body, notification.signature, signal())).toEqual({
      type: 'valid',
    });
    const tampered = notification.body.replace('110000000001', '110000000002');
    expect(await subject.verify(tampered, notification.signature, signal())).toEqual({
      type: 'invalid',
      reason: 'bad_signature',
    });
  });

  it("accepts the signed JSON re-serialized with whitespace, as eBay's SDKs check it", async () => {
    const notification = fake.notification('ORDER_CONFIRMATION', ORDER);
    const pretty = JSON.stringify(JSON.parse(notification.body), null, 2);
    expect(await verifier().verify(pretty, notification.signature, signal())).toEqual({
      type: 'valid',
    });
  });

  it('rejects a missing, malformed, or foreign signature header', async () => {
    const subject = verifier();
    const { body, signature } = fake.notification('ORDER_CONFIRMATION', ORDER);
    expect(await subject.verify(body, undefined, signal())).toEqual({
      type: 'invalid',
      reason: 'missing_signature',
    });
    expect(await subject.verify(body, 'not base64 json', signal())).toEqual({
      type: 'invalid',
      reason: 'malformed_signature',
    });
    const header = JSON.parse(Buffer.from(signature, 'base64').toString('utf8')) as Record<
      string,
      string
    >;
    const otherKey = Buffer.from(JSON.stringify({ ...header, kid: 'unknown-key' })).toString(
      'base64',
    );
    expect(await subject.verify(body, otherKey, signal())).toEqual({
      type: 'invalid',
      reason: 'unknown_key',
    });
  });

  it('fetches a key once an hour and remembers unknown key ids for a while', async () => {
    const subject = verifier();
    const before = keyFetches();
    const first = fake.notification('ORDER_CONFIRMATION', ORDER);
    const second = fake.notification('LISTING', {
      listingId: '110000000001',
      reason: 'ENDED',
      user: ORDER.user,
    });
    await Promise.all([
      subject.verify(first.body, first.signature, signal()),
      subject.verify(second.body, second.signature, signal()),
    ]);
    expect(keyFetches() - before).toBe(1);

    clock += 59 * 60_000;
    await subject.verify(first.body, first.signature, signal());
    expect(keyFetches() - before).toBe(1);
    clock += 2 * 60_000;
    await subject.verify(first.body, first.signature, signal());
    expect(keyFetches() - before).toBe(2);

    const header = JSON.parse(Buffer.from(first.signature, 'base64').toString('utf8')) as Record<
      string,
      string
    >;
    const forged = Buffer.from(JSON.stringify({ ...header, kid: 'forged' })).toString('base64');
    await subject.verify(first.body, forged, signal());
    await subject.verify(first.body, forged, signal());
    expect(keyFetches() - before).toBe(3);
  });

  it('keeps forged key ids from pushing out the real key or spending the call limit', async () => {
    const subject = new EbayNotificationVerifier({
      endpoints: { api: fake.url },
      token: new ApplicationToken(
        new EbayOAuthClient({
          tokenUrl: `${fake.url}/identity/v1/oauth2/token`,
          clientId: FAKE_EBAY_CLIENT_ID,
          clientSecret: FAKE_EBAY_CLIENT_SECRET,
        }),
      ),
      maxCachedKeys: 2,
      maxNewKeyFetchesPerMinute: 3,
      now: () => clock,
    });
    clock = Date.now();
    const notification = fake.notification('ORDER_CONFIRMATION', ORDER);
    expect(await subject.verify(notification.body, notification.signature, signal())).toEqual({
      type: 'valid',
    });
    const header = JSON.parse(
      Buffer.from(notification.signature, 'base64').toString('utf8'),
    ) as Record<string, string>;
    const forged = (kid: string): string =>
      Buffer.from(JSON.stringify({ ...header, kid })).toString('base64');

    const before = keyFetches();
    const verdicts = [];
    for (const kid of ['forged-1', 'forged-2', 'forged-3', 'forged-4']) {
      verdicts.push(await subject.verify(notification.body, forged(kid), signal()));
    }
    expect(verdicts).toEqual([
      { type: 'invalid', reason: 'unknown_key' },
      { type: 'invalid', reason: 'unknown_key' },
      { type: 'unavailable', code: 'key_fetches_limited' },
      { type: 'unavailable', code: 'key_fetches_limited' },
    ]);
    // The real key was fetched first (one new id), so two forged ids used up the budget.
    expect(keyFetches() - before).toBe(2);
    // The real key is still cached, and an expired real key is fetched again despite the limit.
    expect(await subject.verify(notification.body, notification.signature, signal())).toEqual({
      type: 'valid',
    });
    expect(keyFetches() - before).toBe(2);
    clock += 61 * 60_000;
    for (const kid of ['forged-5', 'forged-6', 'forged-7']) {
      await subject.verify(notification.body, forged(kid), signal());
    }
    expect(await subject.verify(notification.body, notification.signature, signal())).toEqual({
      type: 'valid',
    });
  });

  it('answers unavailable when the key cannot be read now, and fetches it again later', async () => {
    const subject = verifier();
    const notification = fake.notification('ORDER_CONFIRMATION', ORDER);
    fake.inject({ action: 'public_key', fault: { type: 'server_error' } });
    expect(await subject.verify(notification.body, notification.signature, signal())).toEqual({
      type: 'unavailable',
      code: 'http_503',
    });
    expect(await subject.verify(notification.body, notification.signature, signal())).toEqual({
      type: 'valid',
    });
  });

  it('decodes only well-formed headers', () => {
    const encode = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString('base64');
    expect(decodeSignatureHeader(encode({ kid: 'abc-1', signature: 'c2ln' }))).toEqual({
      kid: 'abc-1',
      signature: 'c2ln',
    });
    expect(decodeSignatureHeader(encode({ kid: '../../x', signature: 'c2ln' }))).toBeUndefined();
    expect(decodeSignatureHeader(encode({ kid: 'abc' }))).toBeUndefined();
    expect(decodeSignatureHeader('x'.repeat(5000))).toBeUndefined();
  });
});

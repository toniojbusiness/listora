import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { TokenDecryptError } from './cipher.ts';
import { KmsTokenCipher, kmsKeyRegion } from './kms-cipher.ts';
import { LocalTokenCipher } from './local-cipher.ts';
import { FAKE_KEY_ARN, FakeKms } from './test-support.ts';

const CONTEXT = { purpose: 'marketplace_session', account: 'acct-1', connection: 'conn-1' };
const SECRET = Buffer.from('session=s3cr3t');

function setup() {
  const kms = new FakeKms();
  return { kms, cipher: new KmsTokenCipher({ keyId: FAKE_KEY_ARN, client: kms.client() }) };
}

describe('KmsTokenCipher', () => {
  it('encrypts under a fresh data key per value and decrypts through KMS', async () => {
    const { kms, cipher } = setup();
    const first = await cipher.encrypt(SECRET, CONTEXT);
    const second = await cipher.encrypt(SECRET, CONTEXT);
    expect(first.includes(Buffer.from('s3cr3t'))).toBe(false);
    expect(first.subarray(0, 2)).toEqual(Buffer.from([1, 2]));
    expect(first.equals(second)).toBe(false);
    expect(await cipher.decrypt(first, CONTEXT)).toEqual(SECRET);
    expect(kms.calls.map((call) => call.operation)).toEqual([
      'GenerateDataKey',
      'GenerateDataKey',
      'Decrypt',
    ]);
    // KMS sees the context (ids only), so its key policy and CloudTrail can use it.
    expect(kms.calls.every((call) => call.context['purpose'] === 'marketplace_session')).toBe(true);
  });

  it('refuses a ciphertext under another context, changed, or from the local key', async () => {
    const { cipher } = setup();
    const sealed = await cipher.encrypt(SECRET, CONTEXT);
    await expect(cipher.decrypt(sealed, { ...CONTEXT, connection: 'conn-2' })).rejects.toThrow(
      TokenDecryptError,
    );
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 1] = (flipped.at(-1) ?? 0) ^ 1;
    await expect(cipher.decrypt(flipped, CONTEXT)).rejects.toThrow(TokenDecryptError);
    await expect(cipher.decrypt(sealed.subarray(0, 5), CONTEXT)).rejects.toThrow(TokenDecryptError);
    const local = await new LocalTokenCipher(randomBytes(32)).encrypt(SECRET, CONTEXT);
    await expect(cipher.decrypt(local, CONTEXT)).rejects.toThrow('not KMS');
  });

  it('throws KMS outages as they are, so the caller retries instead of discarding', async () => {
    const { kms, cipher } = setup();
    const sealed = await cipher.encrypt(SECRET, CONTEXT);
    kms.failWith = { status: 503, type: 'KMSInternalException' };
    const failure = await cipher.decrypt(sealed, CONTEXT).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(TokenDecryptError);
    await expect(cipher.encrypt(SECRET, CONTEXT)).rejects.toThrow();
  });

  it('takes its region from the key ARN', () => {
    expect(kmsKeyRegion(FAKE_KEY_ARN)).toBe('us-east-1');
    expect(kmsKeyRegion('arn:aws:kms:eu-west-2:123456789012:alias/listora-prod-tokens')).toBe(
      'eu-west-2',
    );
    expect(() => kmsKeyRegion('alias/listora-prod-tokens')).toThrow(RangeError);
    expect(() => new KmsTokenCipher({ keyId: '1234abcd-12ab-34cd-56ef-1234567890ab' })).toThrow(
      RangeError,
    );
  });
});

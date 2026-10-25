import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { TokenDecryptError } from './cipher.ts';
import { LocalTokenCipher } from './local-cipher.ts';

const CONTEXT = { purpose: 'marketplace_session', account: 'acct-1', connection: 'conn-1' };
const SECRET = Buffer.from('{"cookies":[{"name":"session","value":"s3cr3t"}]}');

describe('LocalTokenCipher', () => {
  const cipher = new LocalTokenCipher(randomBytes(32));

  it('decrypts what it encrypted, and never stores the plaintext', async () => {
    const sealed = await cipher.encrypt(SECRET, CONTEXT);
    expect(sealed.includes(Buffer.from('s3cr3t'))).toBe(false);
    expect(sealed.subarray(0, 2)).toEqual(Buffer.from([1, 1]));
    expect(await cipher.decrypt(sealed, CONTEXT)).toEqual(SECRET);
  });

  it('uses a fresh IV for every encryption', async () => {
    const first = await cipher.encrypt(SECRET, CONTEXT);
    const second = await cipher.encrypt(SECRET, CONTEXT);
    expect(first.equals(second)).toBe(false);
  });

  it('binds the ciphertext to its context, whatever the key order', async () => {
    const sealed = await cipher.encrypt(SECRET, CONTEXT);
    const reordered = { connection: 'conn-1', account: 'acct-1', purpose: 'marketplace_session' };
    expect(await cipher.decrypt(sealed, reordered)).toEqual(SECRET);
    for (const other of [
      { ...CONTEXT, connection: 'conn-2' },
      { ...CONTEXT, account: 'acct-2' },
      { ...CONTEXT, purpose: 'marketplace_tokens' },
      { purpose: 'marketplace_session', account: 'acct-1' },
    ]) {
      await expect(cipher.decrypt(sealed, other)).rejects.toThrow(TokenDecryptError);
    }
  });

  it('refuses a ciphertext that was changed, cut, or made with another key', async () => {
    const sealed = await cipher.encrypt(SECRET, CONTEXT);
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 1] = (flipped.at(-1) ?? 0) ^ 1;
    await expect(cipher.decrypt(flipped, CONTEXT)).rejects.toThrow(TokenDecryptError);
    await expect(cipher.decrypt(sealed.subarray(0, 20), CONTEXT)).rejects.toThrow(
      TokenDecryptError,
    );
    await expect(new LocalTokenCipher(randomBytes(32)).decrypt(sealed, CONTEXT)).rejects.toThrow(
      'another local key',
    );
  });

  it('refuses unknown formats and KMS ciphertexts', async () => {
    const sealed = await cipher.encrypt(SECRET, CONTEXT);
    const future = Buffer.from(sealed);
    future[0] = 2;
    await expect(cipher.decrypt(future, CONTEXT)).rejects.toThrow('unknown ciphertext format');
    const kms = Buffer.from(sealed);
    kms[1] = 2;
    await expect(cipher.decrypt(kms, CONTEXT)).rejects.toThrow('made with kms');
  });

  it('refuses an empty context and a key of the wrong size', async () => {
    await expect(cipher.encrypt(SECRET, {})).rejects.toThrow(RangeError);
    await expect(cipher.encrypt(SECRET, { account: '' })).rejects.toThrow(RangeError);
    expect(() => new LocalTokenCipher(randomBytes(16))).toThrow(RangeError);
  });
});

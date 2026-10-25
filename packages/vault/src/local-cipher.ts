/**
 * The development and test `TokenCipher`: AES-256-GCM under one local key (`TOKEN_LOCAL_KEY`,
 * or the per-checkout key file `.local/token.key`). Each ciphertext carries the key's
 * fingerprint, so a value encrypted with another key fails with a clear error instead of a bare
 * authentication failure. Production uses KMS envelope encryption instead (kms-cipher.ts).
 */
import { createHash } from 'node:crypto';

import {
  contextBytes,
  DATA_KEY_BYTES,
  header,
  openWithKey,
  readHeader,
  sealWithKey,
  TokenDecryptError,
  type EncryptionContext,
  type TokenCipher,
} from './cipher.ts';

const FINGERPRINT_BYTES = 4;

export class LocalTokenCipher implements TokenCipher {
  readonly keySource = 'local' as const;
  readonly #key: Buffer;
  readonly #fingerprint: Buffer;

  constructor(key: Uint8Array) {
    if (key.length !== DATA_KEY_BYTES) {
      throw new RangeError(`a local token key is ${String(DATA_KEY_BYTES)} bytes`);
    }
    this.#key = Buffer.from(key);
    this.#fingerprint = createHash('sha256')
      .update(this.#key)
      .digest()
      .subarray(0, FINGERPRINT_BYTES);
  }

  encrypt(plaintext: Uint8Array, context: EncryptionContext): Promise<Buffer> {
    return settle(() => {
      const sealed = sealWithKey(this.#key, plaintext, contextBytes(context));
      return Buffer.concat([header('local'), this.#fingerprint, sealed]);
    });
  }

  decrypt(ciphertext: Uint8Array, context: EncryptionContext): Promise<Buffer> {
    return settle(() => {
      const { source, rest } = readHeader(ciphertext);
      if (source !== 'local') {
        throw new TokenDecryptError(`the ciphertext was made with ${source}, not the local key`);
      }
      if (!rest.subarray(0, FINGERPRINT_BYTES).equals(this.#fingerprint)) {
        throw new TokenDecryptError('the ciphertext was made with another local key');
      }
      return openWithKey(this.#key, rest.subarray(FINGERPRINT_BYTES), contextBytes(context));
    });
  }
}

/** Runs synchronous work as a promise, so every failure is a rejection, never a throw. */
function settle<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

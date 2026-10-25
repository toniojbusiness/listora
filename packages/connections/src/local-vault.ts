/**
 * The development token vault: data keys are wrapped with AES-256-GCM under a local key
 * (`TOKEN_ENCRYPTION_KEY`), the same envelope as KMS. The wrapped key starts with the first 8
 * bytes of the local key's SHA-256, so a ciphertext sealed under another key is reported as
 * such instead of as damage.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import type { OAuthTokens } from '@listora/marketplaces';

import {
  DATA_KEY_BYTES,
  parseSealed,
  sealWithDataKey,
  tokenAad,
  TokenVaultError,
  type TokenContext,
  type TokenVault,
} from './vault.ts';

const KEY_ID_BYTES = 8;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class LocalTokenVault implements TokenVault {
  readonly #key: Buffer;
  readonly #keyId: Buffer;

  /** `key`: 32 random bytes (`TOKEN_ENCRYPTION_KEY`, base64). */
  constructor(key: Buffer) {
    if (key.length !== DATA_KEY_BYTES) {
      throw new Error(`the local token key must be ${String(DATA_KEY_BYTES)} bytes`);
    }
    this.#key = Buffer.from(key);
    this.#keyId = createHash('sha256').update(key).digest().subarray(0, KEY_ID_BYTES);
  }

  seal(tokens: OAuthTokens, context: TokenContext): Promise<Buffer> {
    const dataKey = randomBytes(DATA_KEY_BYTES);
    try {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
      cipher.setAAD(tokenAad(context));
      const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()]);
      const wrappedKey = Buffer.concat([this.#keyId, iv, cipher.getAuthTag(), wrapped]);
      return Promise.resolve(sealWithDataKey('local', dataKey, wrappedKey, tokens, context));
    } finally {
      dataKey.fill(0);
    }
  }

  open(ciphertext: Buffer, context: TokenContext): Promise<OAuthTokens> {
    try {
      const sealed = parseSealed(ciphertext);
      if (sealed.driver !== 'local') {
        throw new TokenVaultError(
          'corrupt',
          'token ciphertext was sealed by KMS, not the local key',
        );
      }
      const { wrappedKey } = sealed;
      if (!wrappedKey.subarray(0, KEY_ID_BYTES).equals(this.#keyId)) {
        throw new TokenVaultError('corrupt', 'token ciphertext was sealed under another local key');
      }
      const iv = wrappedKey.subarray(KEY_ID_BYTES, KEY_ID_BYTES + IV_BYTES);
      const tag = wrappedKey.subarray(KEY_ID_BYTES + IV_BYTES, KEY_ID_BYTES + IV_BYTES + TAG_BYTES);
      let dataKey: Buffer;
      try {
        const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
        decipher.setAAD(tokenAad(context));
        decipher.setAuthTag(tag);
        dataKey = Buffer.concat([
          decipher.update(wrappedKey.subarray(KEY_ID_BYTES + IV_BYTES + TAG_BYTES)),
          decipher.final(),
        ]);
      } catch (error) {
        throw new TokenVaultError('corrupt', 'token ciphertext does not decrypt', { cause: error });
      }
      try {
        return Promise.resolve(sealed.open(dataKey, context));
      } finally {
        dataKey.fill(0);
      }
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

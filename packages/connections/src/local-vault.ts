/**
 * The development token vault: data keys are wrapped with AES-256-GCM under a local key
 * (`TOKEN_ENCRYPTION_KEY`), the same envelope as KMS. The wrapped key starts with the first 8
 * bytes of the local key's SHA-256, so a ciphertext sealed under another key is reported as
 * such instead of as damage.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import type { OAuthTokens } from '@listora/marketplaces';

import {
  credentialAad,
  DATA_KEY_BYTES,
  parseSealed,
  sealWithDataKey,
  tokensFromPlaintext,
  tokensPlaintext,
  TokenVaultError,
  type CredentialKind,
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
    const plaintext = tokensPlaintext(tokens);
    try {
      return settle(() => this.#seal('tokens', plaintext, context));
    } finally {
      plaintext.fill(0);
    }
  }

  open(ciphertext: Buffer, context: TokenContext): Promise<OAuthTokens> {
    return settle(() => tokensFromPlaintext(this.#open('tokens', ciphertext, context)));
  }

  sealSession(session: Uint8Array, context: TokenContext): Promise<Buffer> {
    return settle(() => this.#seal('session', session, context));
  }

  openSession(ciphertext: Buffer, context: TokenContext): Promise<Buffer> {
    return settle(() => this.#open('session', ciphertext, context));
  }

  #seal(kind: CredentialKind, plaintext: Uint8Array, context: TokenContext): Buffer {
    const aad = credentialAad(kind, context);
    const dataKey = randomBytes(DATA_KEY_BYTES);
    try {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
      cipher.setAAD(aad);
      const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()]);
      const wrappedKey = Buffer.concat([this.#keyId, iv, cipher.getAuthTag(), wrapped]);
      return sealWithDataKey('local', dataKey, wrappedKey, plaintext, aad);
    } finally {
      dataKey.fill(0);
    }
  }

  #open(kind: CredentialKind, ciphertext: Buffer, context: TokenContext): Buffer {
    const aad = credentialAad(kind, context);
    const sealed = parseSealed(ciphertext);
    if (sealed.driver !== 'local') {
      throw new TokenVaultError('corrupt', 'ciphertext was sealed by KMS, not the local key');
    }
    const { wrappedKey } = sealed;
    if (!wrappedKey.subarray(0, KEY_ID_BYTES).equals(this.#keyId)) {
      throw new TokenVaultError('corrupt', 'ciphertext was sealed under another local key');
    }
    const iv = wrappedKey.subarray(KEY_ID_BYTES, KEY_ID_BYTES + IV_BYTES);
    const tag = wrappedKey.subarray(KEY_ID_BYTES + IV_BYTES, KEY_ID_BYTES + IV_BYTES + TAG_BYTES);
    let dataKey: Buffer;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      dataKey = Buffer.concat([
        decipher.update(wrappedKey.subarray(KEY_ID_BYTES + IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
    } catch (error) {
      throw new TokenVaultError('corrupt', 'credential ciphertext does not decrypt', {
        cause: error,
      });
    }
    try {
      return sealed.open(dataKey, aad);
    } finally {
      dataKey.fill(0);
    }
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

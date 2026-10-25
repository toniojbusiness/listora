/**
 * The token vault: marketplace OAuth tokens are stored only encrypted, with envelope
 * encryption (docs/architecture.md section 5). Every seal makes a new random 256-bit data key,
 * encrypts the tokens with it (AES-256-GCM), and stores the data key only wrapped by the key
 * encryption key: a KMS key in deployed environments (`KmsTokenVault`), a local key from
 * `TOKEN_ENCRYPTION_KEY` in development (`LocalTokenVault`).
 *
 * Each ciphertext is bound to its connection: the marketplace and connection id are the
 * AES-GCM additional data (and the KMS encryption context), so a ciphertext copied onto
 * another connection or account does not decrypt.
 *
 * Only the worker opens ciphertexts, at use time (`ConnectionCredentials`, the health check,
 * revocation). The API only seals the tokens of a new grant: it gets a `TokenSealer`, which
 * cannot decrypt, and its KMS permissions allow `GenerateDataKey` but not `Decrypt`.
 *
 * Layout (version 1): `LTV` `0x01`, the driver byte (1 local, 2 KMS), the wrapped data key's
 * length (2 bytes, big-endian) and bytes, the 12-byte IV, the 16-byte tag, and the ciphertext
 * of the JSON `{ "accessToken", "refreshToken" }`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { Marketplace } from '@listora/db';
import type { OAuthTokens } from '@listora/marketplaces';

export interface TokenContext {
  marketplace: Marketplace;
  connectionId: string;
}

/** Encrypts tokens; cannot decrypt (the API's side). */
export interface TokenSealer {
  seal(tokens: OAuthTokens, context: TokenContext): Promise<Buffer>;
}

/** Encrypts and decrypts tokens (the worker's side). */
export interface TokenVault extends TokenSealer {
  open(ciphertext: Buffer, context: TokenContext): Promise<OAuthTokens>;
}

/**
 * A ciphertext that cannot be opened. `corrupt`: it never will (damaged, for another
 * connection, or sealed with another key). `unavailable`: the key service failed; try later.
 * Messages never contain token material.
 */
export class TokenVaultError extends Error {
  readonly kind: 'corrupt' | 'unavailable';

  constructor(kind: 'corrupt' | 'unavailable', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TokenVaultError';
    this.kind = kind;
  }
}

export const VAULT_DRIVERS = { local: 1, kms: 2 } as const;
export type VaultDriver = keyof typeof VAULT_DRIVERS;

const MAGIC = Buffer.from('LTV\u0001', 'latin1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const DATA_KEY_BYTES = 32;

/** The additional data a ciphertext is bound to. */
export function tokenAad(context: TokenContext): Buffer {
  return Buffer.from(
    `listora:marketplace-tokens:v1:${context.marketplace}:${context.connectionId}`,
  );
}

/** The vault's own seal with an unwrapped data key; drivers supply `wrappedKey`. */
export function sealWithDataKey(
  driver: VaultDriver,
  dataKey: Buffer,
  wrappedKey: Buffer,
  tokens: OAuthTokens,
  context: TokenContext,
): Buffer {
  if (wrappedKey.length > 0xffff) throw new Error('wrapped data key too long');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(tokenAad(context));
  const plaintext = Buffer.from(
    JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }),
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  plaintext.fill(0);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(wrappedKey.length);
  return Buffer.concat([
    MAGIC,
    Buffer.from([VAULT_DRIVERS[driver]]),
    length,
    wrappedKey,
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]);
}

/** The parts of a sealed ciphertext; throws `corrupt` for anything else. */
export function parseSealed(sealed: Buffer): {
  driver: VaultDriver;
  wrappedKey: Buffer;
  open: (dataKey: Buffer, context: TokenContext) => OAuthTokens;
} {
  const header = MAGIC.length + 1 + 2;
  if (sealed.length < header || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new TokenVaultError('corrupt', 'not a Listora token ciphertext');
  }
  const driverByte = sealed[MAGIC.length];
  const driver = (Object.keys(VAULT_DRIVERS) as VaultDriver[]).find(
    (name) => VAULT_DRIVERS[name] === driverByte,
  );
  if (driver === undefined) throw new TokenVaultError('corrupt', 'unknown token vault driver');
  const keyLength = sealed.readUInt16BE(MAGIC.length + 1);
  const keyEnd = header + keyLength;
  if (sealed.length < keyEnd + IV_BYTES + TAG_BYTES) {
    throw new TokenVaultError('corrupt', 'token ciphertext is truncated');
  }
  const wrappedKey = sealed.subarray(header, keyEnd);
  const iv = sealed.subarray(keyEnd, keyEnd + IV_BYTES);
  const tag = sealed.subarray(keyEnd + IV_BYTES, keyEnd + IV_BYTES + TAG_BYTES);
  const ciphertext = sealed.subarray(keyEnd + IV_BYTES + TAG_BYTES);
  return {
    driver,
    wrappedKey,
    open: (dataKey, context) => {
      let plaintext: Buffer;
      try {
        const decipher = createDecipheriv('aes-256-gcm', dataKey, iv);
        decipher.setAAD(tokenAad(context));
        decipher.setAuthTag(tag);
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch (error) {
        throw new TokenVaultError('corrupt', 'token ciphertext does not decrypt', {
          cause: error,
        });
      }
      try {
        const parsed = JSON.parse(plaintext.toString('utf8')) as Partial<OAuthTokens>;
        if (typeof parsed.accessToken !== 'string' || typeof parsed.refreshToken !== 'string') {
          throw new TokenVaultError('corrupt', 'token ciphertext holds no tokens');
        }
        return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
      } catch (error) {
        if (error instanceof TokenVaultError) throw error;
        throw new TokenVaultError('corrupt', 'token ciphertext holds no tokens');
      } finally {
        plaintext.fill(0);
      }
    },
  };
}

/** A sealer that holds no way to decrypt, for processes that must not (the API). */
export function sealOnly(vault: TokenSealer): TokenSealer {
  return { seal: (tokens, context) => vault.seal(tokens, context) };
}

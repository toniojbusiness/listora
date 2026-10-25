/**
 * The token vault: marketplace credentials are stored only encrypted, with envelope encryption
 * (docs/features/connections.md). Every seal makes a new random 256-bit data key, encrypts the
 * credential with it (AES-256-GCM), and stores the data key only wrapped by the key encryption
 * key: a KMS key in deployed environments (`KmsTokenVault`), a local key from
 * `TOKEN_ENCRYPTION_KEY` in development (`LocalTokenVault`).
 *
 * A credential is one of two kinds: the OAuth tokens of an `api` connection (`seal`, `open`),
 * or the browser session of an `automation` connection (`sealSession`, `openSession`; the
 * session vault's JSON, session-vault.ts). Each ciphertext is bound to its kind and its
 * connection: both are the AES-GCM additional data, and the KMS encryption context (whose
 * `purpose` names the kind, `CREDENTIAL_PURPOSES`), so a ciphertext copied onto another
 * connection or account, or opened as the other kind, does not decrypt.
 *
 * Each process opens only its own kind, at use time. The worker opens OAuth tokens
 * (`ConnectionCredentials`, the health check, revocation); only the browser runner opens
 * browser sessions. The API only seals: it gets a `TokenSealer`, which cannot decrypt. In AWS
 * the task roles say the same: `GenerateDataKey` for every task, `Decrypt` for the worker only
 * with the tokens' purpose and for the runner only with the sessions'.
 *
 * Layout (version 1): `LTV` `0x01`, the driver byte (1 local, 2 KMS), the wrapped data key's
 * length (2 bytes, big-endian) and bytes, the 12-byte IV, the 16-byte tag, and the ciphertext
 * of the credential (for tokens, the JSON `{ "accessToken", "refreshToken" }`).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { Marketplace } from '@listora/db';
import type { OAuthTokens } from '@listora/marketplaces';

export interface TokenContext {
  marketplace: Marketplace;
  connectionId: string;
}

/**
 * The KMS encryption context `purpose` of each kind of credential. IAM policies key on it
 * (infra's compute stack keeps a copy, which its tests compare with this one).
 */
export const CREDENTIAL_PURPOSES = {
  tokens: 'listora-marketplace-tokens',
  session: 'listora-marketplace-session',
} as const;
export type CredentialKind = keyof typeof CREDENTIAL_PURPOSES;

/** Encrypts credentials; cannot decrypt (the API's side). */
export interface TokenSealer {
  seal(tokens: OAuthTokens, context: TokenContext): Promise<Buffer>;
  /** Encrypts a browser session; `session` is the session vault's serialized session. */
  sealSession(session: Uint8Array, context: TokenContext): Promise<Buffer>;
}

/** Encrypts and decrypts credentials (the worker's and the browser runner's side). */
export interface TokenVault extends TokenSealer {
  open(ciphertext: Buffer, context: TokenContext): Promise<OAuthTokens>;
  openSession(ciphertext: Buffer, context: TokenContext): Promise<Buffer>;
}

/**
 * A ciphertext that cannot be opened. `corrupt`: it never will (damaged, for another
 * connection or kind, or sealed with another key). `unavailable`: the key service failed; try
 * later. Messages never contain credential material.
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

const AAD_PREFIXES: Readonly<Record<CredentialKind, string>> = {
  tokens: 'listora:marketplace-tokens:v1',
  session: 'listora:marketplace-session:v1',
};

/** The additional data a ciphertext of `kind` is bound to. */
export function credentialAad(kind: CredentialKind, context: TokenContext): Buffer {
  return Buffer.from(`${AAD_PREFIXES[kind]}:${context.marketplace}:${context.connectionId}`);
}

/** The KMS encryption context of a ciphertext of `kind`. */
export function encryptionContext(
  kind: CredentialKind,
  context: TokenContext,
): Record<string, string> {
  return {
    purpose: CREDENTIAL_PURPOSES[kind],
    marketplace: context.marketplace,
    connectionId: context.connectionId,
  };
}

/** The vault's own seal with an unwrapped data key; drivers supply `wrappedKey`. */
export function sealWithDataKey(
  driver: VaultDriver,
  dataKey: Buffer,
  wrappedKey: Buffer,
  plaintext: Uint8Array,
  aad: Buffer,
): Buffer {
  if (wrappedKey.length > 0xffff) throw new Error('wrapped data key too long');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
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
  /** The plaintext; the caller zeroes it once it has read it. */
  open: (dataKey: Buffer, aad: Buffer) => Buffer;
} {
  const header = MAGIC.length + 1 + 2;
  if (sealed.length < header || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new TokenVaultError('corrupt', 'not a Listora credential ciphertext');
  }
  const driverByte = sealed[MAGIC.length];
  const driver = (Object.keys(VAULT_DRIVERS) as VaultDriver[]).find(
    (name) => VAULT_DRIVERS[name] === driverByte,
  );
  if (driver === undefined) throw new TokenVaultError('corrupt', 'unknown token vault driver');
  const keyLength = sealed.readUInt16BE(MAGIC.length + 1);
  const keyEnd = header + keyLength;
  if (sealed.length < keyEnd + IV_BYTES + TAG_BYTES) {
    throw new TokenVaultError('corrupt', 'credential ciphertext is truncated');
  }
  const wrappedKey = sealed.subarray(header, keyEnd);
  const iv = sealed.subarray(keyEnd, keyEnd + IV_BYTES);
  const tag = sealed.subarray(keyEnd + IV_BYTES, keyEnd + IV_BYTES + TAG_BYTES);
  const ciphertext = sealed.subarray(keyEnd + IV_BYTES + TAG_BYTES);
  return {
    driver,
    wrappedKey,
    open: (dataKey, aad) => {
      try {
        const decipher = createDecipheriv('aes-256-gcm', dataKey, iv);
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch (error) {
        throw new TokenVaultError('corrupt', 'credential ciphertext does not decrypt', {
          cause: error,
        });
      }
    },
  };
}

/** The plaintext of OAuth tokens. */
export function tokensPlaintext(tokens: OAuthTokens): Buffer {
  return Buffer.from(
    JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }),
  );
}

/** OAuth tokens from their plaintext, which it zeroes; throws `corrupt` for anything else. */
export function tokensFromPlaintext(plaintext: Buffer): OAuthTokens {
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
}

/** A sealer that holds no way to decrypt, for processes that must not (the API). */
export function sealOnly(vault: TokenSealer): TokenSealer {
  return {
    seal: (tokens, context) => vault.seal(tokens, context),
    sealSession: (session, context) => vault.sealSession(session, context),
  };
}

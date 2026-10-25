/**
 * Token encryption (docs/architecture.md section 7): every marketplace credential Listora keeps
 * (OAuth tokens, and the browser session cookies of an automation connection) is stored only
 * as ciphertext made by a `TokenCipher`. Production uses KMS envelope encryption
 * (`TOKEN_KMS_KEY_ID`, kms-cipher.ts); development and tests use a local AES-256-GCM key
 * (local-cipher.ts). Both bind each ciphertext to its encryption context (the purpose, account,
 * and connection), so a ciphertext copied onto another row never decrypts.
 *
 * Stored format, versioned so the scheme can change without a migration:
 *
 *   byte 0     format version (1)
 *   byte 1     key source: 1 = local key, 2 = KMS
 *   local:     key fingerprint (4) | IV (12) | GCM tag (16) | ciphertext
 *   KMS:       encrypted data key length (2, big-endian) | encrypted data key | IV | tag | ciphertext
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * What a ciphertext is bound to. Every value must be non-empty; KMS records it in CloudTrail,
 * so it names ids, never secrets.
 */
export type EncryptionContext = Readonly<Record<string, string>>;

export interface TokenCipher {
  /** Which key protects new ciphertexts, for logs and health output (never key material). */
  readonly keySource: KeySource;
  encrypt(plaintext: Uint8Array, context: EncryptionContext): Promise<Buffer>;
  /** Throws `TokenDecryptError` when the ciphertext, its key, or its context do not match. */
  decrypt(ciphertext: Uint8Array, context: EncryptionContext): Promise<Buffer>;
}

export const KEY_SOURCES = ['local', 'kms'] as const;
export type KeySource = (typeof KEY_SOURCES)[number];

export const FORMAT_VERSION = 1;
export const KEY_SOURCE_BYTE = { local: 1, kms: 2 } as const satisfies Record<KeySource, number>;

export const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The ciphertext can't be decrypted: corrupt, made with another key, or for another context. */
export class TokenDecryptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TokenDecryptError';
  }
}

/** Checks a context and returns its canonical form (keys sorted), the AES-GCM associated data. */
export function contextBytes(context: EncryptionContext): Buffer {
  const entries = Object.entries(context).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) throw new RangeError('an encryption context needs at least one entry');
  for (const [key, value] of entries) {
    if (key === '' || value === '') {
      throw new RangeError('encryption context keys and values must be non-empty');
    }
  }
  return Buffer.from(`listora-token-v1\n${JSON.stringify(entries)}`, 'utf8');
}

/** AES-256-GCM under `key`: IV | tag | ciphertext. */
export function sealWithKey(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** Opens what `sealWithKey` made; throws `TokenDecryptError` when anything does not match. */
export function openWithKey(key: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Buffer {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new TokenDecryptError('the ciphertext is cut');
  const bytes = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const iv = bytes.subarray(0, IV_BYTES);
  const tag = bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = bytes.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch (error) {
    throw new TokenDecryptError('the ciphertext does not match its key or encryption context', {
      cause: error,
    });
  }
}

/** Reads the format header; returns the key source and the rest of the bytes. */
export function readHeader(ciphertext: Uint8Array): { source: KeySource; rest: Buffer } {
  const bytes = Buffer.from(ciphertext.buffer, ciphertext.byteOffset, ciphertext.byteLength);
  if (bytes.length < 2) throw new TokenDecryptError('the ciphertext is cut');
  if (bytes[0] !== FORMAT_VERSION) {
    throw new TokenDecryptError(`unknown ciphertext format ${String(bytes[0])}`);
  }
  const source = KEY_SOURCES.find((name) => KEY_SOURCE_BYTE[name] === bytes[1]);
  if (source === undefined) throw new TokenDecryptError(`unknown key source ${String(bytes[1])}`);
  return { source, rest: bytes.subarray(2) };
}

export function header(source: KeySource): Buffer {
  return Buffer.from([FORMAT_VERSION, KEY_SOURCE_BYTE[source]]);
}

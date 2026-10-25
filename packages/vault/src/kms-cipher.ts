/**
 * The production `TokenCipher`: KMS envelope encryption. Each `encrypt` asks KMS for a fresh
 * AES-256 data key (`GenerateDataKey`) under `TOKEN_KMS_KEY_ID`, encrypts locally with it, and
 * stores only the KMS-encrypted copy of the data key next to the ciphertext; the plaintext data
 * key is wiped right after use. `decrypt` asks KMS to decrypt the data key. The encryption
 * context goes to KMS too, which binds it to the data key cryptographically and records it in
 * CloudTrail, so it names ids, never secrets.
 *
 * KMS errors other than a mismatching ciphertext (throttling, network, access) are thrown as
 * they are, so the caller retries instead of treating the credential as unreadable.
 */
import {
  DecryptCommand,
  GenerateDataKeyCommand,
  InvalidCiphertextException,
  KMSClient,
  type KMSClientConfig,
} from '@aws-sdk/client-kms';

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

/** A KMS key ARN or alias ARN; its region is the KMS endpoint's. */
export const KMS_KEY_ARN_PATTERN =
  /^arn:aws[a-z-]*:kms:([a-z]{2}(?:-[a-z]+)+-\d+):\d{12}:(?:key\/[0-9a-f-]{36}|alias\/[\w/-]+)$/;

/** The longest encrypted data key KMS returns for a symmetric key is well under this. */
const MAX_ENCRYPTED_KEY_BYTES = 0xffff;

export interface KmsTokenCipherOptions {
  /** The key ARN (or alias ARN) that wraps every data key. */
  keyId: string;
  /** Defaults to a client for the key's region with the default AWS credential chain. */
  client?: KMSClient;
}

export class KmsTokenCipher implements TokenCipher {
  readonly keySource = 'kms' as const;
  readonly #keyId: string;
  readonly #client: KMSClient;

  constructor(options: KmsTokenCipherOptions) {
    const region = kmsKeyRegion(options.keyId);
    this.#keyId = options.keyId;
    this.#client = options.client ?? createKmsClient({ region });
  }

  async encrypt(plaintext: Uint8Array, context: EncryptionContext): Promise<Buffer> {
    const aad = contextBytes(context);
    const generated = await this.#client.send(
      new GenerateDataKeyCommand({
        KeyId: this.#keyId,
        KeySpec: 'AES_256',
        EncryptionContext: { ...context },
      }),
    );
    const dataKey = generated.Plaintext;
    const encryptedKey = generated.CiphertextBlob;
    if (dataKey?.length !== DATA_KEY_BYTES || encryptedKey === undefined) {
      throw new Error('KMS returned no usable data key');
    }
    if (encryptedKey.length === 0 || encryptedKey.length > MAX_ENCRYPTED_KEY_BYTES) {
      throw new Error('KMS returned an encrypted data key of an unexpected size');
    }
    try {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(encryptedKey.length);
      return Buffer.concat([
        header('kms'),
        length,
        encryptedKey,
        sealWithKey(dataKey, plaintext, aad),
      ]);
    } finally {
      dataKey.fill(0);
    }
  }

  async decrypt(ciphertext: Uint8Array, context: EncryptionContext): Promise<Buffer> {
    const aad = contextBytes(context);
    const { source, rest } = readHeader(ciphertext);
    if (source !== 'kms') {
      throw new TokenDecryptError(`the ciphertext was made with the ${source} key, not KMS`);
    }
    if (rest.length < 2) throw new TokenDecryptError('the ciphertext is cut');
    const keyLength = rest.readUInt16BE(0);
    const encryptedKey = rest.subarray(2, 2 + keyLength);
    if (keyLength === 0 || encryptedKey.length !== keyLength) {
      throw new TokenDecryptError('the ciphertext is cut');
    }
    let dataKey: Uint8Array | undefined;
    try {
      const decrypted = await this.#client.send(
        new DecryptCommand({
          KeyId: this.#keyId,
          CiphertextBlob: encryptedKey,
          EncryptionContext: { ...context },
        }),
      );
      dataKey = decrypted.Plaintext;
    } catch (error) {
      if (error instanceof InvalidCiphertextException) {
        throw new TokenDecryptError('KMS refused the data key: wrong key or encryption context', {
          cause: error,
        });
      }
      throw error;
    }
    if (dataKey?.length !== DATA_KEY_BYTES) throw new Error('KMS returned no usable data key');
    try {
      return openWithKey(dataKey, rest.subarray(2 + keyLength), aad);
    } finally {
      dataKey.fill(0);
    }
  }
}

/** The region of a KMS key ARN; throws for anything else. */
export function kmsKeyRegion(keyId: string): string {
  const region = KMS_KEY_ARN_PATTERN.exec(keyId)?.[1];
  if (region === undefined) throw new RangeError('the KMS key must be a key ARN or alias ARN');
  return region;
}

export function createKmsClient(config: KMSClientConfig): KMSClient {
  return new KMSClient({ maxAttempts: 3, ...config });
}

/**
 * The deployed token vault: AWS KMS envelope encryption. Each seal asks KMS for a new data key
 * (`GenerateDataKey`, AES-256) under the token key and stores only its KMS ciphertext; opening
 * asks KMS to decrypt that (`Decrypt`). Both pass the credential's kind (`purpose`) and
 * connection as the encryption context, so KMS itself refuses a ciphertext moved to another
 * connection or opened as the other kind, IAM can allow each process only its own kind, and
 * CloudTrail records which connection each use was for. The plaintext data key exists only in
 * memory, briefly.
 */
import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
  type KMSClientConfig,
} from '@aws-sdk/client-kms';

import type { OAuthTokens } from '@listora/marketplaces';

import {
  credentialAad,
  DATA_KEY_BYTES,
  encryptionContext,
  parseSealed,
  sealWithDataKey,
  tokensFromPlaintext,
  tokensPlaintext,
  TokenVaultError,
  type CredentialKind,
  type TokenContext,
  type TokenVault,
} from './vault.ts';

/** KMS errors that say the ciphertext itself is unusable (it will never decrypt). */
const PERMANENT_KMS_ERRORS = new Set([
  'InvalidCiphertextException',
  'IncorrectKeyException',
  'NotFoundException',
]);

export interface KmsTokenVaultOptions {
  /** The token key's id or ARN (`TOKEN_KMS_KEY_ID`). */
  keyId: string;
  /**
   * Extra SDK client settings. Production passes only the region: credentials come from the
   * default AWS chain (the ECS task role: `kms:GenerateDataKey` for every task, plus
   * `kms:Decrypt` of tokens for the worker and of sessions for the browser runner). Tests point
   * `endpoint` at a local fake.
   */
  client?: KMSClientConfig;
}

export class KmsTokenVault implements TokenVault {
  readonly #client: KMSClient;
  readonly #keyId: string;

  constructor(options: KmsTokenVaultOptions) {
    this.#client = new KMSClient({ ...options.client });
    this.#keyId = options.keyId;
  }

  async seal(tokens: OAuthTokens, context: TokenContext): Promise<Buffer> {
    const plaintext = tokensPlaintext(tokens);
    try {
      return await this.#seal('tokens', plaintext, context);
    } finally {
      plaintext.fill(0);
    }
  }

  async open(ciphertext: Buffer, context: TokenContext): Promise<OAuthTokens> {
    return tokensFromPlaintext(await this.#open('tokens', ciphertext, context));
  }

  sealSession(session: Uint8Array, context: TokenContext): Promise<Buffer> {
    return this.#seal('session', session, context);
  }

  openSession(ciphertext: Buffer, context: TokenContext): Promise<Buffer> {
    return this.#open('session', ciphertext, context);
  }

  async #seal(kind: CredentialKind, plaintext: Uint8Array, context: TokenContext): Promise<Buffer> {
    let key;
    try {
      key = await this.#client.send(
        new GenerateDataKeyCommand({
          KeyId: this.#keyId,
          KeySpec: 'AES_256',
          EncryptionContext: encryptionContext(kind, context),
        }),
      );
    } catch (error) {
      throw new TokenVaultError('unavailable', 'KMS did not generate a data key', { cause: error });
    }
    if (key.Plaintext?.length !== DATA_KEY_BYTES || key.CiphertextBlob === undefined) {
      throw new TokenVaultError('unavailable', 'KMS returned no usable data key');
    }
    const dataKey = Buffer.from(key.Plaintext);
    key.Plaintext.fill(0);
    try {
      return sealWithDataKey(
        'kms',
        dataKey,
        Buffer.from(key.CiphertextBlob),
        plaintext,
        credentialAad(kind, context),
      );
    } finally {
      dataKey.fill(0);
    }
  }

  async #open(kind: CredentialKind, ciphertext: Buffer, context: TokenContext): Promise<Buffer> {
    const sealed = parseSealed(ciphertext);
    if (sealed.driver !== 'kms') {
      throw new TokenVaultError('corrupt', 'ciphertext was sealed by the local key, not KMS');
    }
    let decrypted;
    try {
      decrypted = await this.#client.send(
        new DecryptCommand({
          KeyId: this.#keyId,
          CiphertextBlob: sealed.wrappedKey,
          EncryptionContext: encryptionContext(kind, context),
        }),
      );
    } catch (error) {
      const name = (error as { name?: unknown }).name;
      const errorKind =
        typeof name === 'string' && PERMANENT_KMS_ERRORS.has(name) ? 'corrupt' : 'unavailable';
      throw new TokenVaultError(errorKind, 'KMS did not decrypt the data key', { cause: error });
    }
    if (decrypted.Plaintext?.length !== DATA_KEY_BYTES) {
      throw new TokenVaultError('corrupt', 'KMS returned no usable data key');
    }
    const dataKey = Buffer.from(decrypted.Plaintext);
    decrypted.Plaintext.fill(0);
    try {
      return sealed.open(dataKey, credentialAad(kind, context));
    } finally {
      dataKey.fill(0);
    }
  }
}

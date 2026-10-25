/**
 * Signed eBay notifications, as the Commerce Notification API delivers them: a JSON body
 * `{ metadata, notification }` POSTed to the subscriber, with an `X-EBAY-SIGNATURE` header that
 * is the base64 of `{"alg":"ecdsa","kid":...,"signature":...,"digest":"SHA1"}`, where
 * `signature` is a base64 DER ECDSA (SHA-1) signature of the JSON body. The subscriber gets the
 * key for `kid` from `getPublicKey`, which answers `{ key, algorithm: "ECDSA", digest: "SHA1" }`
 * with the PEM key on one line. This is how eBay's own event-notification SDKs verify it
 * (github.com/eBay/event-notification-nodejs-sdk, lib/validator.js).
 *
 * The fake signs with its own P-256 test key, so a verifier built for eBay accepts the fake's
 * notifications and rejects tampered ones.
 */
import { createSign, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';

export interface NotificationMessage {
  metadata: { topic: string; schemaVersion: string; deprecated: boolean };
  notification: {
    notificationId: string;
    eventDate: string;
    publishDate: string;
    publishAttemptCount: number;
    data: Record<string, unknown>;
  };
}

export interface SignedNotification {
  message: NotificationMessage;
  /** The exact request body. */
  body: string;
  /** The `X-EBAY-SIGNATURE` header value. */
  signature: string;
}

export interface PublicKeyResponse {
  key: string;
  algorithm: 'ECDSA';
  digest: 'SHA1';
}

export class NotificationSigner {
  readonly keyId = randomUUID();
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.#privateKey = privateKey;
    this.#publicKey = publicKey;
  }

  /** `getPublicKey` for this signer's key id. */
  publicKey(): PublicKeyResponse {
    const pem = this.#publicKey.export({ type: 'spki', format: 'pem' });
    // eBay serves the PEM on one line, without the line breaks.
    return { key: pem.replace(/\n/g, ''), algorithm: 'ECDSA', digest: 'SHA1' };
  }

  sign(
    topic: string,
    data: Record<string, unknown>,
    options: { schemaVersion?: string; at?: Date } = {},
  ): SignedNotification {
    const at = (options.at ?? new Date()).toISOString();
    const message: NotificationMessage = {
      metadata: { topic, schemaVersion: options.schemaVersion ?? '1.0', deprecated: false },
      notification: {
        notificationId: `${randomUUID()}_${randomUUID()}`,
        eventDate: at,
        publishDate: at,
        publishAttemptCount: 1,
        data,
      },
    };
    const body = JSON.stringify(message);
    const signer = createSign('SHA1');
    signer.update(body);
    const signature = signer.sign(this.#privateKey, 'base64');
    const header = { alg: 'ecdsa', kid: this.keyId, signature, digest: 'SHA1' };
    return {
      message,
      body,
      signature: Buffer.from(JSON.stringify(header)).toString('base64'),
    };
  }
}

/**
 * The phone runtime's signature (docs/features/phone-execution.md#the-runtimes-signature): CI
 * signs the bundle with Listora's offline Ed25519 release key when it builds the image, and the
 * app runs a runtime the server hands it only when the signature verifies with the public key
 * the app is built with. The server never holds the private key, so a server, an image, or a
 * deploy someone else controls can't hand every phone code of its own.
 *
 * The signature covers the runtime's version and its digest (SHA-256 of the source), so neither
 * can be swapped for another release's.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

/**
 * The release key's public half (raw, base64), pinned in the app too
 * (`RuntimeSignature.publicKey`, PhoneExecutionFeature). Its private half is the GitHub Actions
 * secret `PHONE_RUNTIME_SIGNING_KEY` and nowhere else; replacing it means a new app build.
 */
export const PHONE_RUNTIME_PUBLIC_KEY = '9wBwY9uOMkb8mOLQOO1mOmQ8FQNVqG0te9VoAV4UmQ4=';

/** What the release key signs: the runtime's version and digest, in a fixed form. */
export function phoneRuntimeSignedMessage(runtimeVersion: number, digest: string): Buffer {
  return Buffer.from(`listora-phone-runtime\n${String(runtimeVersion)}\n${digest}`, 'utf8');
}

/** The signature (base64) of a runtime, with the private key in PEM (PKCS #8). */
export function signPhoneRuntime(
  privateKeyPem: string,
  runtimeVersion: number,
  digest: string,
): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the signing key is not Ed25519');
  return sign(null, phoneRuntimeSignedMessage(runtimeVersion, digest), key).toString('base64');
}

/** Whether `signature` (base64) is the key's over this version and digest. */
export function verifyPhoneRuntime(
  signature: string,
  runtimeVersion: number,
  digest: string,
  publicKey: string = PHONE_RUNTIME_PUBLIC_KEY,
): boolean {
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length !== 64) return false;
  return verify(
    null,
    phoneRuntimeSignedMessage(runtimeVersion, digest),
    rawPublicKey(publicKey),
    bytes,
  );
}

/** The public key from its raw 32 bytes (base64), as the app pins it. */
export function rawPublicKey(base64: string): KeyObject {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(base64, 'base64').toString('base64url') },
    format: 'jwk',
  });
}

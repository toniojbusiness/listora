import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPhoneBundle } from './bundle-file.ts';
import { PHONE_RUNTIME_VERSION } from './runtime.ts';
import { signPhoneBundle } from './sign.ts';
import {
  PHONE_RUNTIME_PUBLIC_KEY,
  phoneRuntimeSignedMessage,
  signPhoneRuntime,
  verifyPhoneRuntime,
} from './signing.ts';

/** A stand-in release key: the real one's private half is only in GitHub Actions. */
function releaseKey(): { privateKeyPem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: Buffer.from(jwk.x ?? '', 'base64url').toString('base64'),
  };
}

const digestOf = (source: string): string => createHash('sha256').update(source).digest('hex');

describe("the phone runtime's signature", () => {
  it('signs the version and digest, and verifies only those', () => {
    const key = releaseKey();
    const digest = digestOf('runtime');
    const signature = signPhoneRuntime(key.privateKeyPem, 3, digest);

    expect(phoneRuntimeSignedMessage(3, digest).toString()).toBe(
      `listora-phone-runtime\n3\n${digest}`,
    );
    expect(verifyPhoneRuntime(signature, 3, digest, key.publicKey)).toBe(true);
    // Another version, another bundle, another key, or a damaged signature never verify.
    expect(verifyPhoneRuntime(signature, 2, digest, key.publicKey)).toBe(false);
    expect(verifyPhoneRuntime(signature, 3, digestOf('other'), key.publicKey)).toBe(false);
    expect(verifyPhoneRuntime(signature, 3, digest, releaseKey().publicKey)).toBe(false);
    expect(verifyPhoneRuntime(signature, 3, digest)).toBe(false);
    expect(verifyPhoneRuntime('not a signature', 3, digest, key.publicKey)).toBe(false);
    expect(verifyPhoneRuntime(`${signature.slice(0, -4)}AAA=`, 3, digest, key.publicKey)).toBe(
      false,
    );
  });

  it('refuses a key that is not Ed25519', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(() =>
      signPhoneRuntime(privateKey.export({ type: 'pkcs8', format: 'pem' }), 3, 'd'),
    ).toThrow('not Ed25519');
  });

  it('pins the same public key in the app', async () => {
    const swift = await readFile(
      fileURLToPath(
        new URL(
          '../../../../apps/ios/Packages/Features/Sources/PhoneExecutionFeature/RuntimeSignature.swift',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    expect(swift).toContain(`"${PHONE_RUNTIME_PUBLIC_KEY}"`);
  });
});

describe('the signed bundle the server hands out', () => {
  let directory: string;
  let bundle: string;
  let signature: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'phone-bundle-'));
    bundle = join(directory, 'phone-runtime.js');
    signature = `${bundle}.sig`;
    await writeFile(bundle, 'globalThis.listoraPhone = {};\n');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("carries the release key's signature of this bundle", async () => {
    const key = releaseKey();
    expect(await signPhoneBundle(key.privateKeyPem, bundle, signature, key.publicKey)).toBe(true);

    const loaded = await loadPhoneBundle(bundle, signature, key.publicKey);
    expect(loaded.digest).toBe(digestOf(await readFile(bundle, 'utf8')));
    expect(loaded.signature).not.toBeNull();
    expect(
      verifyPhoneRuntime(
        loaded.signature ?? '',
        PHONE_RUNTIME_VERSION,
        loaded.digest,
        key.publicKey,
      ),
    ).toBe(true);
  });

  it('has no signature without one, or with one of another bundle or key', async () => {
    const key = releaseKey();
    expect((await loadPhoneBundle(bundle, signature, key.publicKey)).signature).toBeNull();

    await signPhoneBundle(key.privateKeyPem, bundle, signature, key.publicKey);
    // The bundle changed after it was signed.
    await writeFile(bundle, 'globalThis.listoraPhone = { changed: true };\n');
    expect((await loadPhoneBundle(bundle, signature, key.publicKey)).signature).toBeNull();
    // Signed by a key the app doesn't pin.
    await signPhoneBundle(key.privateKeyPem, bundle, signature, key.publicKey);
    expect((await loadPhoneBundle(bundle, signature, releaseKey().publicKey)).signature).toBeNull();
  });

  it('writes no signature without the key, and removes an old one', async () => {
    const key = releaseKey();
    await signPhoneBundle(key.privateKeyPem, bundle, signature, key.publicKey);

    expect(await signPhoneBundle(undefined, bundle, signature, key.publicKey)).toBe(false);
    await expect(readFile(signature, 'utf8')).rejects.toThrow('ENOENT');
    expect(await signPhoneBundle('  ', bundle, signature, key.publicKey)).toBe(false);
  });

  it('refuses to sign with a key the app does not pin', async () => {
    await expect(signPhoneBundle(releaseKey().privateKeyPem, bundle, signature)).rejects.toThrow(
      'not the release key',
    );
    await expect(readFile(signature, 'utf8')).rejects.toThrow('ENOENT');
  });
});

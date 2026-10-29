/**
 * Signs the phone runtime bundle with the release key (docs/features/phone-execution.md#the-runtimes-signature):
 * `npm run phone:sign` writes the bundle's signature next to it (`phone-runtime.js.sig`), which
 * the image carries and the API hands the app with the bundle. The deploy workflows run it in a
 * step of its own before the image is built, with the GitHub Actions secret
 * `PHONE_RUNTIME_SIGNING_KEY` (PEM, PKCS #8) in that step's environment only; the key is never
 * written to disk or logged. `--check` says whether the bundle's signature verifies (exit 0) or
 * not (exit 3), for scripts/deploy-personal.sh.
 *
 * Without the key it removes any signature left from before and writes none: the server then
 * hands the app an unsigned runtime, which new apps never run (they keep the runtime they have),
 * and older apps run as before.
 */
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadPhoneBundle, PHONE_BUNDLE_PATH, PHONE_BUNDLE_SIGNATURE_PATH } from './bundle-file.ts';
import { PHONE_RUNTIME_VERSION } from './runtime.ts';
import { signPhoneRuntime, verifyPhoneRuntime } from './signing.ts';

/** Writes the signature of the bundle at `path`; false (and none written) without a key. */
export async function signPhoneBundle(
  privateKeyPem: string | undefined,
  path: string = PHONE_BUNDLE_PATH,
  signaturePath: string = PHONE_BUNDLE_SIGNATURE_PATH,
  publicKey?: string,
): Promise<boolean> {
  await rm(signaturePath, { force: true });
  if (privateKeyPem === undefined || privateKeyPem.trim() === '') return false;
  const source = await readFile(path, 'utf8');
  const digest = createHash('sha256').update(source).digest('hex');
  const signature = signPhoneRuntime(privateKeyPem, PHONE_RUNTIME_VERSION, digest);
  // A key that isn't the release key the app pins would sign a runtime no app runs.
  if (!verifyPhoneRuntime(signature, PHONE_RUNTIME_VERSION, digest, publicKey)) {
    throw new Error(
      'the signing key is not the release key the app pins (PHONE_RUNTIME_PUBLIC_KEY)',
    );
  }
  await writeFile(signaturePath, `${signature}\n`);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--check') {
    // Whether the image built now would carry a signature the app accepts (deploy-personal.sh).
    const { signature } = await loadPhoneBundle(PHONE_BUNDLE_PATH, PHONE_BUNDLE_SIGNATURE_PATH);
    process.stdout.write(signature === null ? 'unsigned\n' : 'signed\n');
    process.exitCode = signature === null ? 3 : 0;
  } else {
    const signed = await signPhoneBundle(process.env['PHONE_RUNTIME_SIGNING_KEY']);
    process.stdout.write(
      signed
        ? `signed the phone runtime: ${PHONE_BUNDLE_SIGNATURE_PATH}\n`
        : 'PHONE_RUNTIME_SIGNING_KEY is not set: the phone runtime is not signed, so new apps keep the runtime they have\n',
    );
  }
}

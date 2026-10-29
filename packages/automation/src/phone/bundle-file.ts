/**
 * The phone runtime bundle as built (`npm run phone:bundle`, bundle.ts): where it is kept, and
 * the server's copy of it, which the API hands the app (`getPhoneRuntime`), so the phone always
 * runs the scripts the server replays its answers through (docs/features/phone-execution.md).
 * The application image carries the same file (Dockerfile), and the release key's signature of
 * it when CI signed it (`npm run phone:sign`, sign.ts).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { PHONE_RUNTIME_VERSION } from './runtime.ts';
import { verifyPhoneRuntime } from './signing.ts';

/** Where the app's PhoneExecutionFeature keeps it. */
export const PHONE_BUNDLE_PATH = fileURLToPath(
  new URL(
    '../../../../apps/ios/Packages/Features/Sources/PhoneExecutionFeature/Resources/phone-runtime.js',
    import.meta.url,
  ),
);

/**
 * The bundle's signature (base64, one line), next to it; never committed (CI writes it before
 * it builds the image), and never in the app, which ships its own bundle.
 */
export const PHONE_BUNDLE_SIGNATURE_PATH = `${PHONE_BUNDLE_PATH}.sig`;

export interface PhoneBundle {
  source: string;
  /** Its SHA-256, hex. */
  digest: string;
  /**
   * The release key's signature of this bundle and version, or null when it has none that
   * verifies (a local server, a deploy without the key, a signature of another bundle).
   */
  signature: string | null;
}

let cached: Promise<PhoneBundle> | undefined;

/** The bundle this server runs with, read once. */
export function readPhoneBundle(): Promise<PhoneBundle> {
  cached ??= loadPhoneBundle(PHONE_BUNDLE_PATH, PHONE_BUNDLE_SIGNATURE_PATH);
  return cached;
}

/** The bundle at `path`, with the signature at `signaturePath` when it verifies. */
export async function loadPhoneBundle(
  path: string,
  signaturePath: string,
  publicKey?: string,
): Promise<PhoneBundle> {
  const source = await readFile(path, 'utf8');
  const digest = createHash('sha256').update(source).digest('hex');
  const signature = await readFile(signaturePath, 'utf8').then(
    (text) => text.trim(),
    () => null,
  );
  const valid =
    signature !== null && verifyPhoneRuntime(signature, PHONE_RUNTIME_VERSION, digest, publicKey);
  return { source, digest, signature: valid ? signature : null };
}

/**
 * The phone runtime bundle as built (`npm run phone:bundle`, bundle.ts): where it is kept, and
 * the server's copy of it, which the API hands the app (`getPhoneRuntime`), so the phone always
 * runs the scripts the server replays its answers through (docs/features/phone-execution.md).
 * The application image carries the same file (Dockerfile).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Where the app's PhoneExecutionFeature keeps it. */
export const PHONE_BUNDLE_PATH = fileURLToPath(
  new URL(
    '../../../../apps/ios/Packages/Features/Sources/PhoneExecutionFeature/Resources/phone-runtime.js',
    import.meta.url,
  ),
);

export interface PhoneBundle {
  source: string;
  /** Its SHA-256, hex. */
  digest: string;
}

let cached: Promise<PhoneBundle> | undefined;

/** The bundle this server runs with, read once. */
export function readPhoneBundle(): Promise<PhoneBundle> {
  cached ??= (async () => {
    const source = await readFile(PHONE_BUNDLE_PATH, 'utf8');
    return { source, digest: createHash('sha256').update(source).digest('hex') };
  })();
  return cached;
}

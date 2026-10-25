import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertNever } from '@listora/shared';

import { DATA_KEY_BYTES, type TokenCipher } from './cipher.ts';
import { KMS_KEY_ARN_PATTERN, KmsTokenCipher } from './kms-cipher.ts';
import { LocalTokenCipher } from './local-cipher.ts';

/** `.local/token.key` at the repository root (gitignored): the development key file. */
export const DEFAULT_TOKEN_KEY_FILE = fileURLToPath(
  new URL('../../../.local/token.key', import.meta.url),
);

export type TokenCipherConfig =
  | { readonly driver: 'kms'; readonly keyId: string }
  | { readonly driver: 'local'; readonly key: Buffer }
  /** Development only: the key in this file, created on first use (refused in production). */
  | { readonly driver: 'local-file'; readonly path: string };

export class TokenCipherConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid token encryption configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'TokenCipherConfigError';
    this.issues = issues;
  }
}

/**
 * Reads the token encryption settings (see `.env.example`) once at startup: KMS envelope
 * encryption with `TOKEN_KMS_KEY_ID`, else the local key `TOKEN_LOCAL_KEY`, else (outside
 * production) the checkout's key file, so a local API and runner share one key without any
 * setup. Errors name the bad key but never echo its value.
 */
export function loadTokenCipherConfig(env: NodeJS.ProcessEnv = process.env): TokenCipherConfig {
  const keyId = nonEmpty(env['TOKEN_KMS_KEY_ID']);
  const localKey = nonEmpty(env['TOKEN_LOCAL_KEY']);
  if (keyId !== undefined) {
    const issues: string[] = [];
    if (!KMS_KEY_ARN_PATTERN.test(keyId)) {
      issues.push('TOKEN_KMS_KEY_ID must be a KMS key ARN or alias ARN');
    }
    if (localKey !== undefined) {
      issues.push('TOKEN_LOCAL_KEY must not be set together with TOKEN_KMS_KEY_ID');
    }
    if (issues.length > 0) throw new TokenCipherConfigError(issues);
    return { driver: 'kms', keyId };
  }
  if (localKey !== undefined) {
    const key = Buffer.from(localKey, 'base64');
    if (key.length !== DATA_KEY_BYTES || key.toString('base64') !== localKey) {
      throw new TokenCipherConfigError([
        `TOKEN_LOCAL_KEY must be ${String(DATA_KEY_BYTES)} bytes in base64 (openssl rand -base64 32)`,
      ]);
    }
    return { driver: 'local', key };
  }
  if (env['NODE_ENV'] === 'production') {
    throw new TokenCipherConfigError(['TOKEN_KMS_KEY_ID is required in production']);
  }
  return { driver: 'local-file', path: DEFAULT_TOKEN_KEY_FILE };
}

export function createTokenCipher(config: TokenCipherConfig): TokenCipher {
  switch (config.driver) {
    case 'kms':
      return new KmsTokenCipher({ keyId: config.keyId });
    case 'local':
      return new LocalTokenCipher(config.key);
    case 'local-file':
      return new LocalTokenCipher(readOrCreateKeyFile(config.path));
    default:
      return assertNever(config, 'token cipher driver');
  }
}

/**
 * The key in `path`, created (owner-readable only) when there is none. Two processes starting
 * at once agree on one key: only the first write succeeds, and the other reads it.
 */
function readOrCreateKeyFile(path: string): Buffer {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${randomBytes(DATA_KEY_BYTES).toString('base64')}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
  if (key.length !== DATA_KEY_BYTES) {
    throw new TokenCipherConfigError([`the token key file ${path} does not hold a 32-byte key`]);
  }
  return key;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === '' ? undefined : value;
}

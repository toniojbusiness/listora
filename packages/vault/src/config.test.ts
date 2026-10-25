import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTokenCipher, loadTokenCipherConfig, TokenCipherConfigError } from './config.ts';
import { FAKE_KEY_ARN } from './test-support.ts';

const CONTEXT = { purpose: 'test', account: 'a' };

describe('loadTokenCipherConfig', () => {
  it('uses KMS when TOKEN_KMS_KEY_ID is set', () => {
    expect(loadTokenCipherConfig({ TOKEN_KMS_KEY_ID: FAKE_KEY_ARN })).toEqual({
      driver: 'kms',
      keyId: FAKE_KEY_ARN,
    });
  });

  it('uses TOKEN_LOCAL_KEY, which must be 32 bytes of base64', () => {
    const key = randomBytes(32);
    expect(loadTokenCipherConfig({ TOKEN_LOCAL_KEY: key.toString('base64') })).toEqual({
      driver: 'local',
      key,
    });
    for (const bad of [randomBytes(16).toString('base64'), 'not base64!']) {
      expect(() => loadTokenCipherConfig({ TOKEN_LOCAL_KEY: bad })).toThrow(
        'TOKEN_LOCAL_KEY must be 32 bytes',
      );
    }
  });

  it('falls back to the checkout key file outside production only', () => {
    expect(loadTokenCipherConfig({})).toMatchObject({ driver: 'local-file' });
    expect(loadTokenCipherConfig({ TOKEN_KMS_KEY_ID: '' })).toMatchObject({ driver: 'local-file' });
    expect(() => loadTokenCipherConfig({ NODE_ENV: 'production' })).toThrow(
      'TOKEN_KMS_KEY_ID is required in production',
    );
  });

  it('names bad keys without echoing their values', () => {
    const secret = randomBytes(32).toString('base64');
    let error: unknown;
    try {
      loadTokenCipherConfig({ TOKEN_KMS_KEY_ID: 'not-an-arn', TOKEN_LOCAL_KEY: secret });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TokenCipherConfigError);
    expect((error as TokenCipherConfigError).issues).toEqual([
      'TOKEN_KMS_KEY_ID must be a KMS key ARN or alias ARN',
      'TOKEN_LOCAL_KEY must not be set together with TOKEN_KMS_KEY_ID',
    ]);
    expect(String(error)).not.toContain(secret);
  });
});

describe('createTokenCipher with the key file', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('creates an owner-only key once and every process then shares it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'listora-token-key-'));
    const path = join(dir, 'nested', 'token.key');
    const first = createTokenCipher({ driver: 'local-file', path });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const sealed = await first.encrypt(Buffer.from('secret'), CONTEXT);
    const second = createTokenCipher({ driver: 'local-file', path });
    expect((await second.decrypt(sealed, CONTEXT)).toString()).toBe('secret');
    expect(readFileSync(path, 'utf8').trim()).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it('refuses a key file that holds no 32-byte key', () => {
    dir = mkdtempSync(join(tmpdir(), 'listora-token-key-'));
    const path = join(dir, 'token.key');
    writeFileSync(path, 'short\n');
    expect(() => createTokenCipher({ driver: 'local-file', path })).toThrow(TokenCipherConfigError);
  });
});

import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';

import { createLogger } from '@listora/shared';

import { ApiError } from '../errors.ts';
import { DevAuthDriver, type DevAuthOptions } from './dev-driver.ts';

const EMAIL = 'dev.user@example.com';

function driver(options: Partial<DevAuthOptions> = {}) {
  const codes: string[] = [];
  const logger = createLogger({
    service: 'test',
    level: 'info',
    destination: {
      write: (line: string) => {
        const code = (JSON.parse(line) as { devSignInCode?: string }).devSignInCode;
        if (code !== undefined) codes.push(code);
      },
    },
  });
  const clock = { now: 1_800_000_000_000 };
  const instance = new DevAuthDriver({
    secret: 's'.repeat(32),
    logger,
    now: () => clock.now,
    ...options,
  });
  return { instance, codes, clock };
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
  return error;
}

describe('DevAuthDriver', () => {
  it('prints a 6-digit code and exchanges it once for a session that verifies', async () => {
    const { instance, codes, clock } = driver();
    expect(instance.requestCode(EMAIL)).toEqual({ expiresInSeconds: 600 });
    const [code = ''] = codes;
    expect(code).toMatch(/^\d{6}$/);

    const session = await instance.createSession(EMAIL, code);
    expect(session).toMatchObject({ tokenType: 'Bearer', expiresInSeconds: 86_400 });
    expect(await instance.verifyAccessToken(session.accessToken)).toEqual({
      provider: 'dev',
      subject: EMAIL,
      email: EMAIL,
      issuedAt: clock.now / 1000,
    });
    expect(decodeJwt(session.accessToken)).toMatchObject({
      iss: 'listora-dev-auth',
      aud: 'listora-api',
    });

    expect((await rejection(instance.createSession(EMAIL, code))).code).toBe('unauthenticated');
  });

  it('expires codes and sessions', async () => {
    const { instance, codes, clock } = driver();
    instance.requestCode(EMAIL);
    clock.now += 601_000;
    expect((await rejection(instance.createSession(EMAIL, codes[0] ?? ''))).message).toContain(
      'expired',
    );

    instance.requestCode(EMAIL);
    const session = await instance.createSession(EMAIL, codes[1] ?? '');
    clock.now += 86_401_000;
    expect(await instance.verifyAccessToken(session.accessToken)).toBeUndefined();
  });

  it('discards a code after too many wrong guesses', async () => {
    const { instance, codes } = driver({ maxAttempts: 3 });
    instance.requestCode(EMAIL);
    const wrong = codes[0] === '000000' ? '111111' : '000000';
    expect((await rejection(instance.createSession(EMAIL, wrong))).message).toContain(
      'not correct',
    );
    await rejection(instance.createSession(EMAIL, wrong));
    expect((await rejection(instance.createSession(EMAIL, wrong))).message).toContain('Too many');
    expect((await rejection(instance.createSession(EMAIL, codes[0] ?? ''))).code).toBe(
      'unauthenticated',
    );
  });

  it('replaces an earlier code when a new one is requested', async () => {
    const { instance, codes } = driver();
    instance.requestCode(EMAIL);
    instance.requestCode(EMAIL);
    if (codes[0] !== codes[1]) await rejection(instance.createSession(EMAIL, codes[0] ?? ''));
    await expect(instance.createSession(EMAIL, codes[1] ?? '')).resolves.toBeDefined();
  });

  it('refuses new codes when too many are pending', () => {
    const { instance } = driver({ maxPendingCodes: 2 });
    instance.requestCode('a@example.com');
    instance.requestCode('b@example.com');
    expect(() => instance.requestCode('c@example.com')).toThrow(ApiError);
    // Requesting again for a pending email still works.
    expect(() => instance.requestCode('a@example.com')).not.toThrow();
  });

  it('does not reset the wrong-guess limit when a new code is requested', async () => {
    const { instance, codes, clock } = driver({ maxWrongGuessesPerEmail: 4, maxAttempts: 2 });
    const wrongFor = (code: string | undefined) => (code === '000000' ? '111111' : '000000');
    for (let round = 0; round < 2; round += 1) {
      instance.requestCode(EMAIL);
      const code = codes.at(-1);
      await rejection(instance.createSession(EMAIL, wrongFor(code)));
      await rejection(instance.createSession(EMAIL, wrongFor(code)));
    }
    const limited = (() => {
      try {
        instance.requestCode(EMAIL);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(limited).toBeInstanceOf(ApiError);
    expect((limited as ApiError).code).toBe('rate_limited');
    expect((limited as ApiError).retryAfterSeconds).toBe(3600);
    // Even the right code is refused while the email is limited.
    expect((await rejection(instance.createSession(EMAIL, codes.at(-1) ?? ''))).code).toBe(
      'rate_limited',
    );

    // Other emails are unaffected, and the email can sign in again once the window passes.
    expect(() => instance.requestCode('other@example.com')).not.toThrow();
    clock.now += 3_600_000;
    instance.requestCode(EMAIL);
    await expect(instance.createSession(EMAIL, codes.at(-1) ?? '')).resolves.toBeDefined();
  });

  it('limits wrong guesses across all emails', async () => {
    const { instance, codes } = driver({ maxWrongGuesses: 3 });
    for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) {
      instance.requestCode(email);
      const code = codes.at(-1);
      await rejection(instance.createSession(email, code === '000000' ? '111111' : '000000'));
    }
    expect(() => instance.requestCode('d@example.com')).toThrow('Too many wrong sign-in codes');
  });

  it('rejects tokens it did not sign', async () => {
    const { instance } = driver();
    const other = driver({ secret: 'o'.repeat(32) });
    other.instance.requestCode(EMAIL);
    const foreign = await other.instance.createSession(EMAIL, other.codes[0] ?? '');
    expect(await instance.verifyAccessToken(foreign.accessToken)).toBeUndefined();
    expect(await instance.verifyAccessToken('')).toBeUndefined();
  });
});

import { SignJWT, UnsecuredJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiError } from '../errors.ts';
import { CognitoAuthDriver, type CognitoAuthOptions } from './cognito-driver.ts';
import { FakeCognitoPool, IOS_CLIENT_ID, nowSeconds, TEST_POOL } from './cognito-test-support.ts';

const SUB = '8a1b2c3d-0000-4000-8000-000000000001';

describe('CognitoAuthDriver', () => {
  let pool: FakeCognitoPool;

  beforeAll(async () => {
    pool = await FakeCognitoPool.start();
  });

  afterAll(async () => {
    await pool.close();
  });

  function driver(options: Partial<CognitoAuthOptions> = {}) {
    const instance = new CognitoAuthDriver({
      config: TEST_POOL,
      jwksUrl: pool.jwksUrl,
      ...options,
    });
    return { instance };
  }

  describe('valid tokens', () => {
    it('maps an access token to the Cognito subject and username', async () => {
      const issuedAt = nowSeconds();
      const token = await pool.accessToken(SUB, {}, { issuedAt });
      expect(await driver().instance.verifyAccessToken(token)).toEqual({
        provider: 'cognito',
        subject: SUB,
        username: `signinwithapple_${SUB}`,
        issuedAt,
      });
    });

    it('maps an ID token to the subject, username, and verified email', async () => {
      const issuedAt = nowSeconds();
      const token = await pool.idToken(SUB, 'ada@example.com', {}, { issuedAt });
      expect(await driver().instance.verifyAccessToken(token)).toEqual({
        provider: 'cognito',
        subject: SUB,
        username: `signinwithapple_${SUB}`,
        email: 'ada@example.com',
        issuedAt,
      });
    });

    it('accepts every configured app client', async () => {
      const { instance } = driver();
      for (const clientId of TEST_POOL.clientIds) {
        const access = await pool.accessToken(SUB, { client_id: clientId });
        const id = await pool.idToken(SUB, 'ada@example.com', { aud: clientId });
        expect((await instance.verifyAccessToken(access))?.subject, clientId).toBe(SUB);
        expect((await instance.verifyAccessToken(id))?.subject, clientId).toBe(SUB);
      }
    });

    it('accepts email_verified as the string "true" (federated attribute mapping)', async () => {
      const token = await pool.idToken(SUB, 'ada@example.com', { email_verified: 'true' });
      expect((await driver().instance.verifyAccessToken(token))?.email).toBe('ada@example.com');
    });

    it('leaves out an email that is unverified or malformed', async () => {
      const { instance } = driver();
      const cases = [
        await pool.idToken(SUB, 'ada@example.com', { email_verified: false }),
        await pool.idToken(SUB, 'ada@example.com', { email_verified: undefined }),
        await pool.idToken(SUB, 'not an email'),
        await pool.idToken(SUB, `${'a'.repeat(250)}@example.com`),
      ];
      for (const token of cases) {
        const identity = await instance.verifyAccessToken(token);
        expect(identity?.subject).toBe(SUB);
        expect(identity).not.toHaveProperty('email');
      }
    });
  });

  describe('fails closed', () => {
    it('rejects an expired token', async () => {
      const issuedAt = nowSeconds() - 7200;
      const token = await pool.accessToken(SUB, {}, { issuedAt, ttlSeconds: 3600 });
      expect(await driver().instance.verifyAccessToken(token)).toBeUndefined();
    });

    it('allows only a few seconds of clock difference', async () => {
      const token = await pool.accessToken(SUB, {}, { ttlSeconds: 60 });
      const { instance: justAfter } = driver({ now: () => (nowSeconds() + 63) * 1000 });
      const { instance: later } = driver({ now: () => (nowSeconds() + 70) * 1000 });
      expect(await justAfter.verifyAccessToken(token)).toBeDefined();
      expect(await later.verifyAccessToken(token)).toBeUndefined();
    });

    it('rejects a token issued in the future or older than a day', async () => {
      const { instance } = driver();
      const future = await pool.accessToken(SUB, {}, { issuedAt: nowSeconds() + 600 });
      const ancient = await pool.accessToken(
        SUB,
        {},
        { issuedAt: nowSeconds() - 2 * 86_400, ttlSeconds: 3 * 86_400 },
      );
      expect(await instance.verifyAccessToken(future)).toBeUndefined();
      expect(await instance.verifyAccessToken(ancient)).toBeUndefined();
    });

    it('rejects a token for another app client (wrong audience)', async () => {
      const { instance } = driver();
      const access = await pool.accessToken(SUB, { client_id: 'someoneelsesclient0000000a' });
      const id = await pool.idToken(SUB, 'ada@example.com', { aud: 'someoneelsesclient0000000a' });
      const idWithClientIdOnly = await pool.idToken(SUB, 'ada@example.com', {
        aud: undefined,
        client_id: IOS_CLIENT_ID,
      });
      const accessWithAudOnly = await pool.accessToken(SUB, {
        client_id: undefined,
        aud: IOS_CLIENT_ID,
      });
      for (const token of [access, id, idWithClientIdOnly, accessWithAudOnly]) {
        expect(await instance.verifyAccessToken(token)).toBeUndefined();
      }
    });

    it('rejects a token from another issuer (another pool or region)', async () => {
      const { instance } = driver();
      const issuers = [
        'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_OtherPool',
        'https://cognito-idp.eu-west-1.amazonaws.com/us-east-1_TestPool1',
        `${pool.issuer}/`,
        'listora-dev-auth',
      ];
      for (const iss of issuers) {
        expect(await instance.verifyAccessToken(await pool.accessToken(SUB, { iss })), iss).toBe(
          undefined,
        );
      }
    });

    it('rejects a missing or unknown token_use, and tokens without a subject', async () => {
      const { instance } = driver();
      const cases = [
        await pool.accessToken(SUB, { token_use: undefined }),
        await pool.accessToken(SUB, { token_use: 'refresh' }),
        await pool.accessToken(SUB, { sub: undefined }),
        await pool.accessToken(SUB, { sub: '' }),
        await pool.accessToken(SUB, { sub: 'x'.repeat(256) }),
      ];
      for (const token of cases) {
        expect(await instance.verifyAccessToken(token)).toBeUndefined();
      }
    });

    it('rejects a forged signature, an unsigned token, and an HMAC token', async () => {
      const { instance } = driver();
      // Signed with another key under the id of a key the pool publishes, and under a new id.
      const forged = await pool.accessToken(SUB, {}, { foreignKey: true });
      const forgedUnderNewKid = await pool.accessToken(
        SUB,
        {},
        { foreignKey: true, kid: 'attacker-key' },
      );
      const unsigned = new UnsecuredJWT({
        sub: SUB,
        token_use: 'access',
        client_id: IOS_CLIENT_ID,
        iss: pool.issuer,
      })
        .setIssuedAt()
        .setExpirationTime('1h')
        .encode();
      const hmac = await new SignJWT({ sub: SUB, token_use: 'access', client_id: IOS_CLIENT_ID })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(pool.issuer)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode('s'.repeat(32)));
      for (const token of [forged, forgedUnderNewKid, unsigned, hmac, 'not-a-jwt', '']) {
        expect(await instance.verifyAccessToken(token)).toBeUndefined();
      }
    });

    it('answers 503 instead of letting a request through when the keys cannot be fetched', async () => {
      const { instance } = driver();
      pool.jwksStatus = 500;
      try {
        const error = await instance
          .verifyAccessToken(await pool.accessToken(SUB))
          .catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(ApiError);
        expect(error).toMatchObject({ code: 'service_unavailable', retryable: true });
      } finally {
        pool.jwksStatus = 200;
      }
      // Once the keys are back, the same driver verifies again.
      expect(await instance.verifyAccessToken(await pool.accessToken(SUB))).toBeDefined();
    });

    it('answers 503 when the JWKS endpoint is unreachable', async () => {
      const { instance } = driver({ jwksUrl: new URL('http://127.0.0.1:1/.well-known/jwks.json') });
      await expect(instance.verifyAccessToken(await pool.accessToken(SUB))).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    });
  });

  describe('signing keys', () => {
    it('fetches the JWKS once and serves later tokens from the cache', async () => {
      const { instance } = driver();
      const before = pool.jwksRequests;
      for (let index = 0; index < 5; index += 1) {
        expect(await instance.verifyAccessToken(await pool.accessToken(SUB))).toBeDefined();
      }
      expect(pool.jwksRequests - before).toBe(1);
    });

    it('does not refetch for made-up key ids within the cooldown', async () => {
      const { instance } = driver();
      expect(await instance.verifyAccessToken(await pool.accessToken(SUB))).toBeDefined();
      const before = pool.jwksRequests;
      for (let index = 0; index < 5; index += 1) {
        const token = await pool.accessToken(
          SUB,
          {},
          { foreignKey: true, kid: `made-up-${String(index)}` },
        );
        expect(await instance.verifyAccessToken(token)).toBeUndefined();
      }
      expect(pool.jwksRequests - before).toBe(0);
    });

    it('picks up a rotated key without a restart, and drops a retired one', async () => {
      // A zero cooldown and cache age stand in for the time a real rotation takes.
      const { instance } = driver({ jwksCooldownMs: 0, jwksCacheMaxAgeMs: 0 });
      const oldKid = kidOf(await pool.accessToken(SUB)) ?? '';
      const oldToken = await pool.accessToken(SUB, {}, { kid: oldKid });
      expect(await instance.verifyAccessToken(oldToken)).toBeDefined();

      const newKid = await pool.addKey();
      const newToken = await pool.accessToken(SUB, {}, { kid: newKid });
      expect(await instance.verifyAccessToken(newToken)).toBeDefined();
      // Both keys are published during the rotation.
      expect(await instance.verifyAccessToken(oldToken)).toBeDefined();

      pool.removeKey(oldKid);
      expect(await instance.verifyAccessToken(oldToken)).toBeUndefined();
      expect(await instance.verifyAccessToken(newToken)).toBeDefined();
    });

    it('fetches a newly published key once its id is first seen', async () => {
      const { instance } = driver({ jwksCooldownMs: 0 });
      expect(await instance.verifyAccessToken(await pool.accessToken(SUB))).toBeDefined();
      const newKid = await pool.addKey();
      const before = pool.jwksRequests;
      expect(
        await instance.verifyAccessToken(await pool.accessToken(SUB, {}, { kid: newKid })),
      ).toBeDefined();
      expect(pool.jwksRequests - before).toBe(1);
    });
  });
});

function kidOf(token: string): string | undefined {
  const [header = ''] = token.split('.');
  return (JSON.parse(Buffer.from(header, 'base64url').toString()) as { kid?: string }).kid;
}

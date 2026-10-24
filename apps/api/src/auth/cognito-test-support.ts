/**
 * Test-only stand-ins for a Cognito user pool (not part of the app): a JWKS endpoint on
 * 127.0.0.1 whose keys the test signs tokens with, rotates, or takes down, and a recording
 * user admin. Nothing here talks to AWS.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from 'jose';

import type { CognitoConfig } from '../config.ts';
import { cognitoIssuer } from './cognito-driver.ts';
import type { CognitoUserAdmin } from './cognito-user-admin.ts';

export const TEST_POOL: CognitoConfig = {
  region: 'us-east-1',
  userPoolId: 'us-east-1_TestPool1',
  clientIds: ['iosappclient0000000000000a', 'webappclient000000000000b'],
};
export const [IOS_CLIENT_ID = ''] = TEST_POOL.clientIds;

interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

/** Token claims; a claim set to `undefined` is left out, so tests can drop a standard one. */
export type Claims = Record<string, unknown>;

export interface TokenOptions {
  /** Defaults to the newest published key. */
  kid?: string;
  /** Seconds since the epoch; defaults to now. */
  issuedAt?: number;
  /** Lifetime in seconds (default one hour). */
  ttlSeconds?: number;
  /** Signs with a key the pool does not publish, under `kid`. */
  foreignKey?: boolean;
}

/** A user pool's JWKS endpoint plus a token factory. */
export class FakeCognitoPool {
  readonly issuer = cognitoIssuer(TEST_POOL);
  /** How often the JWKS was fetched. */
  jwksRequests = 0;
  /** The HTTP status the JWKS endpoint answers with (200 serves the keys). */
  jwksStatus = 200;
  readonly #server: Server;
  readonly #keys: SigningKey[] = [];

  private constructor() {
    this.#server = createServer((request, response) => {
      if (request.url !== '/.well-known/jwks.json') {
        response.writeHead(404).end();
        return;
      }
      this.jwksRequests += 1;
      if (this.jwksStatus !== 200) {
        response.writeHead(this.jwksStatus).end();
        return;
      }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ keys: this.#keys.map((key) => key.publicJwk) }));
    });
  }

  static async start(): Promise<FakeCognitoPool> {
    const pool = new FakeCognitoPool();
    await new Promise<void>((resolve) => pool.#server.listen(0, '127.0.0.1', resolve));
    await pool.addKey();
    return pool;
  }

  get jwksUrl(): URL {
    const { port } = this.#server.address() as AddressInfo;
    return new URL(`http://127.0.0.1:${String(port)}/.well-known/jwks.json`);
  }

  /** Publishes a new signing key (it becomes the default for new tokens) and returns its kid. */
  async addKey(): Promise<string> {
    const key = await newKey(randomUUID());
    this.#keys.push(key);
    return key.kid;
  }

  /** Stops publishing a key, as a rotation eventually does. */
  removeKey(kid: string): void {
    const index = this.#keys.findIndex((key) => key.kid === kid);
    if (index >= 0) this.#keys.splice(index, 1);
  }

  /** An access token as Cognito issues it to the app client. */
  accessToken(sub: string, claims: Claims = {}, options: TokenOptions = {}): Promise<string> {
    return this.sign(
      {
        sub,
        token_use: 'access',
        client_id: IOS_CLIENT_ID,
        username: `signinwithapple_${sub}`,
        scope: 'openid email',
        auth_time: options.issuedAt ?? nowSeconds(),
        ...claims,
      },
      options,
    );
  }

  /** An ID token as Cognito issues it to the app client, with a verified email. */
  idToken(
    sub: string,
    email: string,
    claims: Claims = {},
    options: TokenOptions = {},
  ): Promise<string> {
    return this.sign(
      {
        sub,
        token_use: 'id',
        aud: IOS_CLIENT_ID,
        'cognito:username': `signinwithapple_${sub}`,
        email,
        email_verified: true,
        auth_time: options.issuedAt ?? nowSeconds(),
        ...claims,
      },
      options,
    );
  }

  /** Signs arbitrary claims; `iss`, `iat`, `exp`, and `jti` default to a valid token's. */
  async sign(claims: Claims, options: TokenOptions = {}): Promise<string> {
    const published = options.kid
      ? this.#keys.find((key) => key.kid === options.kid)
      : this.#keys.at(-1);
    const kid = options.kid ?? published?.kid ?? randomUUID();
    const key = options.foreignKey === true || !published ? await newKey(kid) : published;
    const issuedAt = options.issuedAt ?? nowSeconds();
    const payload: JWTPayload = {
      iss: this.issuer,
      jti: randomUUID(),
      iat: issuedAt,
      exp: issuedAt + (options.ttlSeconds ?? 3600),
      ...claims,
    };
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .sign(key.privateKey);
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

/** Records deleted usernames; `failWith` makes the next deletions throw. */
export class FakeCognitoUserAdmin implements CognitoUserAdmin {
  readonly deleted: string[] = [];
  failWith: Error | undefined;

  deleteUser(username: string): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.deleted.push(username);
    return Promise.resolve();
  }
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function newKey(kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  return {
    kid,
    privateKey,
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' },
  };
}

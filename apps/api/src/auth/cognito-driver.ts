import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

import type { CognitoConfig } from '../config.ts';
import { ApiError } from '../errors.ts';
import type { AuthDriver, Identity } from './driver.ts';

/** Cognito access and ID tokens live at most one day; anything older is refused outright. */
const MAX_TOKEN_AGE_SECONDS = 86_400;
/** Allowed clock difference between Cognito and this server when checking `exp` and `iat`. */
const CLOCK_TOLERANCE_SECONDS = 5;
/** Longest accepted `sub` and username (`app_user.auth_subject` holds at most 255 characters). */
const MAX_SUBJECT_LENGTH = 255;
/** `app_user.email`: at most 254 characters and shaped like an address. */
const EMAIL = /^[^@\s]+@[^@\s]+$/;
const MAX_EMAIL_LENGTH = 254;

/**
 * jose error codes that mean the token itself is bad (forged, expired, for another audience,
 * signed with a key the pool does not publish). Every other failure, such as the JWKS endpoint
 * being down or answering garbage, means the token could not be checked: that is a `503`, never
 * a pass.
 */
const INVALID_TOKEN_CODES: ReadonlySet<string> = new Set([
  errors.JWTClaimValidationFailed.code,
  errors.JWTExpired.code,
  errors.JWTInvalid.code,
  errors.JWSInvalid.code,
  errors.JWSSignatureVerificationFailed.code,
  errors.JOSEAlgNotAllowed.code,
  errors.JOSENotSupported.code,
  errors.JWKSNoMatchingKey.code,
  errors.JWKSMultipleMatchingKeys.code,
]);

export interface CognitoAuthOptions {
  config: CognitoConfig;
  /** Where the signing keys are fetched; defaults to the pool's published JWKS. Tests serve their own. */
  jwksUrl?: URL;
  /** How long fetched keys are used before they are fetched again (default 10 minutes). */
  jwksCacheMaxAgeMs?: number;
  /**
   * Shortest time between two fetches caused by an unknown key id (default 30 seconds), so
   * tokens with made-up key ids cannot make the API hammer Cognito.
   */
  jwksCooldownMs?: number;
  /** Milliseconds since the epoch; injectable so tests can expire tokens. */
  now?: () => number;
}

/** The issuer of a user pool's tokens: `https://cognito-idp.<region>.amazonaws.com/<pool id>`. */
export function cognitoIssuer(config: CognitoConfig): string {
  return `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
}

/**
 * Production sign-in (`AUTH_DRIVER=cognito`, decision D10). The iPhone app signs in with the
 * Cognito user pool directly (Sign in with Apple through the managed login, or a one-time code
 * by email) and sends the pool's access or ID token as its bearer token. This driver verifies
 * it locally against the pool's published signing keys (JWKS, fetched once and cached; an
 * unknown key id triggers a refetch, so key rotation needs no restart) and checks the issuer,
 * the app client, `token_use`, expiry, and age. Every failure fails closed. Settings the user
 * pool must have are in docs/auth.md.
 */
export class CognitoAuthDriver implements AuthDriver {
  readonly provider = 'cognito' as const;
  readonly #issuer: string;
  readonly #clientIds: ReadonlySet<string>;
  readonly #keys: JWTVerifyGetKey;
  readonly #now: () => number;

  constructor(options: CognitoAuthOptions) {
    this.#issuer = cognitoIssuer(options.config);
    this.#clientIds = new Set(options.config.clientIds);
    this.#keys = createRemoteJWKSet(
      options.jwksUrl ?? new URL(`${this.#issuer}/.well-known/jwks.json`),
      {
        ...(options.jwksCacheMaxAgeMs === undefined
          ? {}
          : { cacheMaxAge: options.jwksCacheMaxAgeMs }),
        ...(options.jwksCooldownMs === undefined
          ? {}
          : { cooldownDuration: options.jwksCooldownMs }),
      },
    );
    this.#now = options.now ?? Date.now;
  }

  async verifyAccessToken(token: string): Promise<Identity | undefined> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.#keys, {
        issuer: this.#issuer,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat', 'token_use'],
        maxTokenAge: MAX_TOKEN_AGE_SECONDS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: new Date(this.#now()),
      }));
    } catch (error) {
      if (error instanceof errors.JOSEError && INVALID_TOKEN_CODES.has(error.code)) {
        return undefined;
      }
      // The error handler logs the cause with the request's id.
      throw new ApiError(
        'service_unavailable',
        'Sign-in cannot be checked right now. Try again in a moment.',
        { retryAfterSeconds: 30, cause: error },
      );
    }
    return this.#identity(payload);
  }

  /** The identity of a token whose signature, issuer, and lifetime already checked out. */
  #identity(payload: JWTPayload): Identity | undefined {
    const { sub, iat } = payload;
    if (typeof sub !== 'string' || !isName(sub) || typeof iat !== 'number') return undefined;
    switch (payload['token_use']) {
      // Access tokens name their app client in `client_id` and have no `aud`.
      case 'access': {
        const clientId = payload['client_id'];
        if (typeof clientId !== 'string' || !this.#clientIds.has(clientId)) return undefined;
        const username = payload['username'];
        return {
          provider: 'cognito',
          subject: sub,
          ...(typeof username === 'string' && isName(username) ? { username } : {}),
          issuedAt: iat,
        };
      }
      // ID tokens name their app client in `aud`, and carry the email address.
      case 'id': {
        const { aud } = payload;
        if (typeof aud !== 'string' || !this.#clientIds.has(aud)) return undefined;
        const username = payload['cognito:username'];
        const email = verifiedEmail(payload);
        return {
          provider: 'cognito',
          subject: sub,
          ...(email === undefined ? {} : { email }),
          ...(typeof username === 'string' && isName(username) ? { username } : {}),
          issuedAt: iat,
        };
      }
      default:
        return undefined;
    }
  }
}

function isName(value: string): boolean {
  return value !== '' && value.length <= MAX_SUBJECT_LENGTH;
}

/**
 * The token's email when Cognito marks it verified. A federated user's `email_verified` comes
 * from the attribute mapping and can arrive as the string `"true"`.
 */
function verifiedEmail(payload: JWTPayload): string | undefined {
  const email = payload['email'];
  const verified = payload['email_verified'];
  if (verified !== true && verified !== 'true') return undefined;
  if (typeof email !== 'string' || email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email)) {
    return undefined;
  }
  return email;
}

import type { AuthProvider } from '@listora/db';
import type { FastifyInstance } from 'fastify';

/** Who a verified access token belongs to, as the identity provider states it. */
export interface Identity {
  provider: AuthProvider;
  /** The provider's stable user id (the Cognito `sub`; the email for the dev driver). */
  subject: string;
  /** Only an address the provider verified; absent otherwise. */
  email?: string;
  /**
   * The provider's name for the user, which its admin API needs to delete them (Cognito's
   * `username`, for example `signinwithapple_000123...` for a Sign in with Apple user). The dev
   * driver has none.
   */
  username?: string;
  /** When the token was issued, in seconds since the epoch (its `iat` claim). */
  issuedAt: number;
}

/**
 * Verifies the bearer tokens of API requests. Drivers (`AUTH_DRIVER`): `dev` signs in with a
 * one-time code printed to the API log; `cognito` verifies tokens of the Cognito user pool.
 */
export interface AuthDriver {
  readonly provider: AuthProvider;
  /**
   * The identity behind a valid, unexpired token; undefined for any other token. Throws an
   * `ApiError('service_unavailable')` when the token cannot be checked right now (for example
   * while the provider's signing keys cannot be fetched), so no request gets through unchecked.
   */
  verifyAccessToken(token: string): Promise<Identity | undefined>;
  /** Registers the driver's own sign-in endpoints, if it has any. */
  registerRoutes?(app: FastifyInstance): void;
}

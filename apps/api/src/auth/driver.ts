import type { AuthProvider } from '@listora/db';
import type { FastifyInstance } from 'fastify';

/** Who a verified access token belongs to, as the identity provider states it. */
export interface Identity {
  provider: AuthProvider;
  /** The provider's stable user id (the Cognito `sub`; the email for the dev driver). */
  subject: string;
  email?: string;
}

/**
 * Verifies the bearer tokens of API requests. Drivers (`AUTH_DRIVER`): `dev` signs in with a
 * one-time code printed to the API log; `cognito` (plan task T-31) verifies Cognito JWTs.
 */
export interface AuthDriver {
  readonly provider: AuthProvider;
  /** The identity behind a valid, unexpired token; undefined for any other token. */
  verifyAccessToken(token: string): Promise<Identity | undefined>;
  /** Registers the driver's own sign-in endpoints, if it has any. */
  registerRoutes?(app: FastifyInstance): void;
}

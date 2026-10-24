import { randomBytes } from 'node:crypto';

import type { FastifyBaseLogger } from 'fastify';

import type { ApiConfig } from '../config.ts';
import { DevAuthDriver } from './dev-driver.ts';
import type { AuthDriver } from './driver.ts';

type AuthConfig = ApiConfig['auth'];

/** One factory per AUTH_DRIVER value; the Record type makes a missing driver a type error. */
const FACTORIES: Record<
  AuthConfig['driver'],
  (auth: AuthConfig, logger: FastifyBaseLogger) => AuthDriver
> = {
  dev: (auth, logger) => {
    let secret = auth.devSecret;
    if (secret === undefined) {
      secret = randomBytes(32).toString('base64url');
      logger.warn('AUTH_DEV_SECRET is not set: dev sessions end when the API restarts');
    }
    return new DevAuthDriver({ secret, logger });
  },
};

/** The auth driver AUTH_DRIVER selects (docs/architecture.md section 7). */
export function createAuthDriver(auth: AuthConfig, logger: FastifyBaseLogger): AuthDriver {
  return FACTORIES[auth.driver](auth, logger);
}

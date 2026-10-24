import { randomBytes } from 'node:crypto';

import { assertNever } from '@listora/shared';
import type { FastifyBaseLogger } from 'fastify';

import type { AuthConfig } from '../config.ts';
import { CognitoAuthDriver } from './cognito-driver.ts';
import { AwsCognitoUserAdmin } from './cognito-user-admin.ts';
import { DevAuthDriver } from './dev-driver.ts';
import type { AuthDriver } from './driver.ts';

/** The auth driver AUTH_DRIVER selects (docs/architecture.md section 7). */
export function createAuthDriver(auth: AuthConfig, logger: FastifyBaseLogger): AuthDriver {
  switch (auth.driver) {
    case 'dev': {
      let secret = auth.devSecret;
      if (secret === undefined) {
        secret = randomBytes(32).toString('base64url');
        logger.warn('AUTH_DEV_SECRET is not set: dev sessions end when the API restarts');
      }
      return new DevAuthDriver({ secret, logger });
    }
    case 'cognito':
      return new CognitoAuthDriver({
        config: auth.cognito,
        userAdmin: new AwsCognitoUserAdmin({
          region: auth.cognito.region,
          userPoolId: auth.cognito.userPoolId,
        }),
      });
    default:
      return assertNever(auth, 'AUTH_DRIVER');
  }
}

import {
  AwsCognitoInviteeDirectory,
  AwsSesRecipientVerifier,
  openInviteeDirectory,
  type InviteeDirectory,
} from '@listora/accounts';
import { assertNever } from '@listora/shared';

import type { ApiConfig } from '../config.ts';

/**
 * Where invitees' users live: nowhere for the dev driver (its codes are in the API log), the
 * user pool for the cognito driver, which with `INVITE_EMAIL_VERIFICATION=ses` also verifies
 * each invitee's address in SES (the pool sends its codes through SES).
 */
export function createInviteeDirectory(
  config: Pick<ApiConfig, 'auth' | 'inviteEmailVerification'>,
): InviteeDirectory {
  const { auth } = config;
  switch (auth.driver) {
    case 'dev':
      return openInviteeDirectory;
    case 'cognito': {
      const { region, userPoolId } = auth.cognito;
      return new AwsCognitoInviteeDirectory({
        region,
        userPoolId,
        ...(config.inviteEmailVerification === 'ses'
          ? { recipients: new AwsSesRecipientVerifier({ region }) }
          : {}),
      });
    }
    default:
      return assertNever(auth, 'AUTH_DRIVER');
  }
}

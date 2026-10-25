import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';

import { ListoraStack, type ListoraStackProps } from './common.ts';

/** The sender of the sign-in emails: `no-reply@<domain>` with a domain, else the owner. */
export const SIGN_IN_SENDER_LOCAL_PART = 'no-reply';

/** Outputs the deploy prints for the iPhone app's Prod configuration (apps/ios/README.md). */
export const AUTH_OUTPUTS = {
  userPoolId: 'UserPoolId',
  appClientId: 'AppClientId',
} as const;

/**
 * The owner pool (`signIn.via === 'owner-pool'`, docs/features/auth.md): a Cognito user pool
 * whose only user is the deploy target's `ownerEmail`, who signs in with a one-time code
 * emailed to them. Nobody can sign up (self sign-up is off and the app client offers no
 * hosted UI), so the pool's users are exactly the ones this stack creates.
 *
 * - Email one-time codes need the Essentials feature plan and SES (`DEVELOPER`) sending. The
 *   email stack holds the owner's address as an SES identity; without a domain the codes come
 *   from that address, with one from `no-reply@<domain>` (its verified domain identity).
 * - The owner is created without a password and without an invitation, verified, so the first
 *   sign-in is an emailed code like every later one. No one-time code without a password means
 *   no password reset either (`AccountRecovery.NONE`).
 * - The iPhone app's client is public (no secret), signs in with `USER_AUTH` only (and
 *   refreshes its tokens), and keeps ID and access tokens for an hour and the refresh token for
 *   30 days. The API refuses tokens older than a day, so neither may exceed that.
 *
 * Users are state: the pool keeps deletion protection and is retained in a protected
 * environment, since a new pool means a new `sub`, and so a new, empty Listora account.
 */
export class AuthStack extends ListoraStack {
  readonly userPool: cognito.UserPool;
  readonly appClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: ListoraStackProps) {
    super(scope, id, props);
    const { settings, target } = props;
    const owner = target.ownerEmail;
    if (owner === undefined) throw new Error('the auth stack needs the owner email');
    const domain = target.dns?.domain;

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `listora-${target.environment}`,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      signInPolicy: { allowedFirstAuthFactors: { password: true, emailOtp: true } },
      mfa: cognito.Mfa.OFF,
      accountRecovery: cognito.AccountRecovery.NONE,
      email: cognito.UserPoolEmail.withSES({
        fromEmail: domain === undefined ? owner : `${SIGN_IN_SENDER_LOCAL_PART}@${domain}`,
        fromName: 'Listora',
        sesRegion: target.region,
        ...(domain === undefined ? {} : { sesVerifiedDomain: domain }),
      }),
      deletionProtection: settings.protectData,
      removalPolicy: settings.protectData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.appClient = this.userPool.addClient('IPhoneApp', {
      userPoolClientName: 'iphone-app',
      generateSecret: false,
      authFlows: { user: true },
      disableOAuth: true,
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      idTokenValidity: Duration.minutes(60),
      accessTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.days(30),
      // Time to open the email and type the code before the sign-in has to start over.
      authSessionValidity: Duration.minutes(10),
    });

    new cognito.CfnUserPoolUser(this, 'Owner', {
      userPoolId: this.userPool.userPoolId,
      username: owner,
      userAttributes: [
        { name: 'email', value: owner },
        { name: 'email_verified', value: 'true' },
      ],
      messageAction: 'SUPPRESS',
    });

    new CfnOutput(this, AUTH_OUTPUTS.userPoolId, { value: this.userPool.userPoolId });
    new CfnOutput(this, AUTH_OUTPUTS.appClientId, { value: this.appClient.userPoolClientId });
  }
}

import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
  type CognitoIdentityProviderClientConfig,
} from '@aws-sdk/client-cognito-identity-provider';

/** The Cognito user pool administration the API needs. */
export interface CognitoUserAdmin {
  /** Deletes the user from the pool; succeeds when there is no such user. */
  deleteUser(username: string): Promise<void>;
}

export interface AwsCognitoUserAdminOptions {
  region: string;
  userPoolId: string;
  /**
   * Extra SDK client settings. Production passes none: credentials come from the default AWS
   * chain (the ECS task role, which needs `cognito-idp:AdminDeleteUser` on the pool). Tests
   * point `endpoint` at a local fake and pass static credentials.
   */
  client?: Omit<CognitoIdentityProviderClientConfig, 'region'>;
}

/** `CognitoUserAdmin` over the AWS SDK (AdminDeleteUser). */
export class AwsCognitoUserAdmin implements CognitoUserAdmin {
  readonly #client: CognitoIdentityProviderClient;
  readonly #userPoolId: string;

  constructor(options: AwsCognitoUserAdminOptions) {
    this.#client = new CognitoIdentityProviderClient({
      // Bounded, so a hung connection cannot hold an account deletion open; the SDK's
      // standard retries still apply.
      requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
      ...options.client,
      region: options.region,
    });
    this.#userPoolId = options.userPoolId;
  }

  async deleteUser(username: string): Promise<void> {
    try {
      await this.#client.send(
        new AdminDeleteUserCommand({ UserPoolId: this.#userPoolId, Username: username }),
      );
    } catch (error) {
      // Already deleted, for example by an earlier attempt whose response was lost.
      if (error instanceof UserNotFoundException) return;
      throw error;
    }
  }
}

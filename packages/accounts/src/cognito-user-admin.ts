import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
  type CognitoIdentityProviderClientConfig,
} from '@aws-sdk/client-cognito-identity-provider';

import { subjectSha256 } from './identity.ts';

/**
 * A Cognito user pool id: the AWS region, an underscore, and the pool's own id
 * (`us-east-1_AbC123xyZ`).
 */
export const USER_POOL_ID_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d_[A-Za-z0-9]+$/;

/** The AWS region of a user pool, taken from its id. */
export function userPoolRegion(userPoolId: string): string {
  const [region = ''] = userPoolId.split('_');
  return region;
}

/** A deleted identity's user in the pool. */
export interface CognitoUserToDelete {
  username: string;
  /** The SHA-256 of the deleted identity's `sub`. */
  subjectSha256: Buffer;
}

/** The Cognito user pool administration account deletion needs. */
export interface CognitoUserAdmin {
  /**
   * Deletes the pool's user named `username` if it still is the deleted identity (its `sub`
   * hashes to `subjectSha256`). Succeeds without deleting anything when there is no such user,
   * or when the name now belongs to a newer user: Cognito reuses a federated user's name
   * (`SignInWithApple_<Apple id>`) when the person signs in again, so a repeated deletion must
   * never delete by name alone.
   */
  deleteUser(user: CognitoUserToDelete): Promise<void>;
}

export interface AwsCognitoUserAdminOptions {
  region: string;
  userPoolId: string;
  /**
   * Extra SDK client settings. Production passes none: credentials come from the default AWS
   * chain (the worker's ECS task role, which needs `cognito-idp:AdminGetUser` and
   * `cognito-idp:AdminDeleteUser` on the pool). Tests
   * point `endpoint` at a local fake and pass static credentials.
   */
  client?: Omit<CognitoIdentityProviderClientConfig, 'region'>;
}

/** `CognitoUserAdmin` over the AWS SDK (AdminGetUser, then AdminDeleteUser). */
export class AwsCognitoUserAdmin implements CognitoUserAdmin {
  readonly #client: CognitoIdentityProviderClient;
  readonly #userPoolId: string;

  constructor(options: AwsCognitoUserAdminOptions) {
    this.#client = new CognitoIdentityProviderClient({
      // Bounded, so a hung connection cannot stall the account deletion job; the SDK's
      // standard retries still apply.
      requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
      ...options.client,
      region: options.region,
    });
    this.#userPoolId = options.userPoolId;
  }

  async deleteUser(user: CognitoUserToDelete): Promise<void> {
    const target = { UserPoolId: this.#userPoolId, Username: user.username };
    let sub: string | undefined;
    try {
      const found = await this.#client.send(new AdminGetUserCommand(target));
      sub = found.UserAttributes?.find((attribute) => attribute.Name === 'sub')?.Value;
    } catch (error) {
      if (error instanceof UserNotFoundException) return;
      throw error;
    }
    if (sub === undefined) throw new Error('Cognito returned a user without a sub');
    if (!subjectSha256(sub).equals(user.subjectSha256)) return;
    try {
      await this.#client.send(new AdminDeleteUserCommand(target));
    } catch (error) {
      // Already deleted, for example by an earlier attempt whose response was lost.
      if (error instanceof UserNotFoundException) return;
      throw error;
    }
  }
}

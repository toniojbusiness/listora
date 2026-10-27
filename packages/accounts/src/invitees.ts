import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
  UsernameExistsException,
  type CognitoIdentityProviderClientConfig,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  AlreadyExistsException,
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  GetEmailIdentityCommand,
  NotFoundException,
  SESv2Client,
  type SESv2ClientConfig,
} from '@aws-sdk/client-sesv2';

/**
 * Whether the sign-in codes reach an invitee's address yet: `deliverable`, or
 * `verification_sent` while the address waits for its owner to click the email provider's
 * verification link (SES's sandbox sends only to verified addresses).
 */
export type InviteeEmailState = 'deliverable' | 'verification_sent';

/**
 * The identity provider's side of invites (docs/features/invites.md): the users invitees sign
 * in as. Every method is safe to repeat, so a retry after a lost answer changes nothing more.
 */
export interface InviteeDirectory {
  /** Lets `email` sign in: creates its user when there is none, and says whether codes reach it. */
  admit(email: string): Promise<InviteeEmailState>;
  /** Removes the user of an address that never signed in (the invitee corrected a typo). */
  forget(email: string): Promise<void>;
  /** Ends the person's sessions and stops them signing in again (their invite was revoked). */
  suspend(email: string): Promise<void>;
  /** Lets a suspended person sign in again, recreating their user if it is gone. */
  resume(email: string): Promise<InviteeEmailState>;
}

/**
 * The dev driver's directory: its identities exist only as signed tokens and its codes appear in
 * the API log, so there is nothing to create, and any address can sign in. Whether a person gets
 * an account is still the API's decision (the tenancy guard checks the invite).
 */
export const openInviteeDirectory: InviteeDirectory = {
  admit: () => Promise.resolve('deliverable'),
  forget: () => Promise.resolve(),
  suspend: () => Promise.resolve(),
  resume: () => Promise.resolve('deliverable'),
};

/** Makes sure SES may send to an address (an SES email identity, verified by its owner). */
export interface RecipientVerifier {
  /** Starts the address's verification when it has none (SES emails a link); idempotent. */
  ensure(email: string): Promise<InviteeEmailState>;
  /** Removes the address's identity; nothing happens when there is none. */
  forget(email: string): Promise<void>;
}

export interface AwsSesRecipientVerifierOptions {
  region: string;
  /** Extra SDK settings; production passes none (the API's task role). Tests set `endpoint`. */
  client?: Omit<SESv2ClientConfig, 'region'>;
}

/**
 * In SES's sandbox, the account sends only to verified addresses, so each invitee's address
 * becomes an SES email identity: creating one emails the address a verification link from AWS,
 * and once it is clicked the pool's sign-in codes reach it. An identity whose link expired
 * (`FAILED`) is created again, which sends a new link. Out of the sandbox this is not needed
 * (`INVITE_EMAIL_VERIFICATION=none`).
 */
export class AwsSesRecipientVerifier implements RecipientVerifier {
  readonly #client: SESv2Client;

  constructor(options: AwsSesRecipientVerifierOptions) {
    this.#client = new SESv2Client({
      requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
      ...options.client,
      region: options.region,
    });
  }

  async ensure(email: string): Promise<InviteeEmailState> {
    let status: string | undefined;
    try {
      const found = await this.#client.send(new GetEmailIdentityCommand({ EmailIdentity: email }));
      status = found.VerificationStatus;
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
    }
    if (status === 'SUCCESS') return 'deliverable';
    if (status === 'PENDING') return 'verification_sent';
    // None yet, or one whose link expired or failed: (re)create it, which sends the link.
    if (status !== undefined) await this.forget(email);
    try {
      await this.#client.send(new CreateEmailIdentityCommand({ EmailIdentity: email }));
    } catch (error) {
      // Created meanwhile by a concurrent redemption: its link is on the way.
      if (!(error instanceof AlreadyExistsException)) throw error;
    }
    return 'verification_sent';
  }

  async forget(email: string): Promise<void> {
    try {
      await this.#client.send(new DeleteEmailIdentityCommand({ EmailIdentity: email }));
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
    }
  }
}

export interface AwsCognitoInviteeDirectoryOptions {
  region: string;
  userPoolId: string;
  /** The SES sandbox's recipient verification; without it every address counts as deliverable. */
  recipients?: RecipientVerifier;
  /**
   * Extra SDK settings. Production passes none: the API's task role may
   * `cognito-idp:AdminCreateUser`, `AdminDeleteUser`, `AdminDisableUser`, `AdminEnableUser`, and
   * `AdminUserGlobalSignOut` on the pool. Tests point `endpoint` at a local fake.
   */
  client?: Omit<CognitoIdentityProviderClientConfig, 'region'>;
}

/**
 * Invitees as users of the Cognito user pool, whose username is the email
 * (`UsernameAttributes: [email]`, so the email names the user in every admin call). A new user is
 * created verified, with no password and no invitation message, like the owner: the pool's
 * emailed one-time code is what proves the address is theirs, at every sign-in.
 */
export class AwsCognitoInviteeDirectory implements InviteeDirectory {
  readonly #client: CognitoIdentityProviderClient;
  readonly #userPoolId: string;
  readonly #recipients: RecipientVerifier | undefined;

  constructor(options: AwsCognitoInviteeDirectoryOptions) {
    this.#client = new CognitoIdentityProviderClient({
      requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
      ...options.client,
      region: options.region,
    });
    this.#userPoolId = options.userPoolId;
    this.#recipients = options.recipients;
  }

  async admit(email: string): Promise<InviteeEmailState> {
    try {
      await this.#client.send(
        new AdminCreateUserCommand({
          UserPoolId: this.#userPoolId,
          Username: email,
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
          ],
          MessageAction: 'SUPPRESS',
        }),
      );
    } catch (error) {
      // Created by an earlier attempt whose answer was lost.
      if (!(error instanceof UsernameExistsException)) throw error;
    }
    return this.#recipients === undefined ? 'deliverable' : this.#recipients.ensure(email);
  }

  async forget(email: string): Promise<void> {
    await this.#ifUserExists(() =>
      this.#client.send(
        new AdminDeleteUserCommand({ UserPoolId: this.#userPoolId, Username: email }),
      ),
    );
    await this.#recipients?.forget(email);
  }

  async suspend(email: string): Promise<void> {
    const user = { UserPoolId: this.#userPoolId, Username: email };
    // Signed out first: disabling stops new sign-ins and refreshes, but only the global sign-out
    // revokes the tokens already issued.
    await this.#ifUserExists(() => this.#client.send(new AdminUserGlobalSignOutCommand(user)));
    await this.#ifUserExists(() => this.#client.send(new AdminDisableUserCommand(user)));
  }

  async resume(email: string): Promise<InviteeEmailState> {
    const user = { UserPoolId: this.#userPoolId, Username: email };
    const enabled = await this.#ifUserExists(() =>
      this.#client.send(new AdminEnableUserCommand(user)),
    );
    if (!enabled) return this.admit(email);
    return this.#recipients === undefined ? 'deliverable' : this.#recipients.ensure(email);
  }

  /** Runs `call` on a user; false when the user does not exist. */
  async #ifUserExists(call: () => Promise<unknown>): Promise<boolean> {
    try {
      await call();
      return true;
    } catch (error) {
      if (error instanceof UserNotFoundException) return false;
      throw error;
    }
  }
}

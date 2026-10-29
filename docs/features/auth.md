# Sign-in and account deletion

How people sign in to Listora and delete their account (plan task T-31, decision D10). The
API side is in `apps/api/src/auth/` and `apps/api/src/account/`, the account deletion job
the worker runs is in `packages/accounts`, the personal environment's user pool is
`infra/src/stacks/auth-stack.ts`, and the app's sign-in is `CognitoSignInClient` (APIClient)
and `SignInModel` (SignInFeature) in `apps/ios`. The API conventions every route follows, the
tenancy guard included, are in [architecture.md](../architecture.md#4-api-conventions).

## Drivers

`AUTH_DRIVER` picks how the API verifies bearer tokens. Every `/v1` request needs one.

| Driver    | Used for                                                          | How a person signs in                                                              |
| --------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `dev`     | Local development and tests; staging and prod until a pool        | A one-time code printed to the API log ([Signing in locally](#signing-in-locally)) |
| `cognito` | The personal environment (its owner pool); staging and prod later | The app signs in with the Cognito user pool and sends the pool's ID token          |

Who gets an account at their first sign-in is a separate switch, `SIGN_UP`: anyone the driver
verified (`open`, the default), or only the owner and the people they invited (`invite`, the
personal environment; [invites.md](invites.md)).

Which driver a deployed environment runs is its `signIn` setting (`ENVIRONMENT_SETTINGS` in
`infra/src/config.ts`), and `signInResources` (`infra/src/containers.ts`) turns it into the
containers' environment: an `owner-pool` environment gets `AUTH_DRIVER=cognito` with its
pool, never the dev driver, and only a `dev` environment gets the dev driver. Either without
the other fails synthesis instead of falling back. `scripts/deploy-personal.sh` refuses to
deploy personal unless the API's `AUTH_DRIVER` is `cognito`, and its smoke test checks that
the deployed API answers `404` on `/dev/auth/codes`.

The API never sees a password or an Apple credential. With `cognito`, the app talks to
Cognito directly, and the API only verifies the tokens Cognito issued.

## Signing in locally

With `AUTH_DRIVER=dev` (the `.env.example` setting), the API signs people in with a one-time
code that it prints to its log instead of emailing it. The first sign-in of an email creates
its account.

```sh
curl -X POST localhost:3000/dev/auth/codes -H 'content-type: application/json' \
  -d '{"email": "you@example.com"}'
# The API log shows: dev sign-in code for you@example.com: 123456
curl -X POST localhost:3000/dev/auth/sessions -H 'content-type: application/json' \
  -d '{"email": "you@example.com", "code": "123456"}'
# → {"accessToken": "...", "tokenType": "Bearer", "expiresInSeconds": 86400}
```

Send the token as `Authorization: Bearer <accessToken>` on every `/v1` request, and an
`Idempotency-Key` header (a new UUID per action) on every POST.

Guessing is limited, in case the driver ever runs where others can reach it. An email gets 10
wrong codes an hour, and all emails together get 100. Asking for a new code does not reset
either limit. Past a limit, both endpoints answer `429 rate_limited` with
`retryAfterSeconds`, even for the right code. The limits live in memory, so they reset when
the API restarts.

No deployed environment runs this driver: the personal environment uses `AUTH_DRIVER=cognito`
with its owner pool ([The owner pool](#the-owner-pool-personal)), and the Deploy workflow
refuses to deploy any environment whose API container has another `AUTH_DRIVER`, so staging
and production deploy once they have their pools (with Sign in with Apple and public
sign-up). The rest of this file covers both drivers, the user pool settings, and in-app
account deletion (`DELETE /v1/account`).

## How the API verifies a Cognito token

`CognitoAuthDriver` (`apps/api/src/auth/cognito-driver.ts`) checks every token locally:

- **Signature.** RS256 only, with a key from the pool's JWKS
  (`https://cognito-idp.<region>.amazonaws.com/<pool id>/.well-known/jwks.json`). The keys are
  fetched on first use and cached for 10 minutes. A token with a key id the cache does not
  know triggers one refetch (at most every 30 seconds), so a key rotation needs no restart and
  made-up key ids cannot make the API flood Cognito.
- **Claims.** `iss` must be the pool; `token_use` must be `id` (then `aud` must be one of
  `COGNITO_CLIENT_IDS`) or `access` (then `client_id` must be). `exp` and `iat` are required,
  with 5 seconds of clock tolerance, and no token older than a day is accepted.
- **Fail closed.** A token that fails any check is `401 unauthenticated`. When the JWKS cannot
  be fetched, the answer is `503 service_unavailable` (retryable), never a pass.

The verified `sub` is the person's identity: `app_user` has `auth_provider = 'cognito'` and
`auth_subject = sub`. The first request creates the user, their account, and the owner
membership (see the tenancy guard). The email is taken only from an ID token whose
`email_verified` is true, and it names the account and sets the SKU prefix, which is why the
app sends the **ID token**. An access token also works, but an account created from one is
named "My account" with the SKU prefix `LS`.

## The owner pool (personal)

The personal environment is one person's own copy of Listora, which they share by invitation,
so its pool (the auth stack, `signIn: { via: 'owner-pool', ... }`) lets in that person and the
people they invite:

- **The owner, and invitees.** The stack creates the deploy target's `ownerEmail`
  (`LISTORA_OWNER_EMAIL`, from deploy config, never from code) as a user, verified, with no
  password and no invitation. Self sign-up is off and the app client has no hosted UI, so nobody
  can get a user on their own: the only other users are the ones the API creates, the same way,
  when someone redeems an invite the owner made, and the API gives an account only to the owner
  and to those invitees (`SIGN_UP=invite`; [invites.md](invites.md)). Changing the owner email
  replaces the owner's user: the new one signs in to a new, empty Listora account.
- **Email one-time codes only.** Essentials plan, `AllowedFirstAuthFactors: [PASSWORD,
EMAIL_OTP]` (Cognito requires `PASSWORD` in the list; nobody has one), MFA off (one-time
  codes cannot be combined with it), and no account recovery (there is no password to reset).
- **SES sending.** Email codes need the pool to send through SES (`DEVELOPER`). The email stack
  holds the owner's address as an SES identity, which in the SES sandbox was also what let SES
  send to it. The account has SES production access since 2026-10-27, so codes reach invitees
  too ([invites.md](invites.md#reaching-invitees-in-the-ses-sandbox)). The codes come from the owner's own address without a domain, and from
  `no-reply@<domain>` (the domain's DKIM-verified identity) with one.
- **The one-time setup.** Creating the identity emails the owner a verification link from AWS.
  `scripts/deploy-personal.sh` waits after the email stack until it is clicked, then deploys
  the pool, and at the end prints `COGNITO_CLIENT_ID` for the iPhone app's
  `Config/Prod.xcconfig` (infra/README.md, Deploying the personal environment).
- **The app client** is the iPhone app's, as specified below for staging and prod, minus the
  OAuth settings: `ALLOW_USER_AUTH` and refresh only, no secret, ID and access tokens for an
  hour, refresh tokens for 30 days, and 10 minutes to enter a code.
- **Deleting the account** in the app deletes the owner's Cognito user too (the worker's job);
  signing in again then needs the user recreated (infra/README.md has the command).

## The flows the app uses

Both flows end with the app holding the pool's ID, access, and refresh tokens. The app keeps
them in the Keychain and refreshes them with the refresh token (`REFRESH_TOKEN_AUTH`).

- **Sign in with Apple** goes through Cognito's managed login (hosted UI) as a federated
  identity provider. The app opens
  `https://<auth domain>/oauth2/authorize?identity_provider=SignInWithApple&response_type=code&client_id=<app client>&redirect_uri=listora://auth/callback&scope=openid+email+profile&code_challenge=...&code_challenge_method=S256`
  in `ASWebAuthenticationSession`, which goes straight to Apple's sheet, and exchanges the
  returned code (with the PKCE verifier) at `https://<auth domain>/oauth2/token`.
- **Email one-time code** uses Cognito's passwordless sign-in (choice-based authentication).
  A returning person calls `InitiateAuth` with `AuthFlow=USER_AUTH` and
  `PREFERRED_CHALLENGE=EMAIL_OTP`, then `RespondToAuthChallenge` with `EMAIL_OTP_CODE`; the app
  does this today (`CognitoSignInClient`, from the welcome screen), against the owner pool. Cognito's
  errors are shown in the app's own words, and a challenge other than `EMAIL_OTP` is refused.
  An invitee does the same once they redeemed their invite ([invites.md](invites.md)), which
  is what creates their user.
  With public sign-up (later), a new person calls `SignUp` with only their email (no password)
  and `ConfirmSignUp` with the emailed code; the returned session signs them in through
  `InitiateAuth` with `AuthFlow=USER_AUTH`.

The app's `AccessTokenStore` renews the ID token with the refresh token 5 minutes before it
expires, one refresh at a time however many requests wait, and treats the session as signed in
while it can still be renewed. A refresh that Cognito rejects (`NotAuthorizedException`: the
refresh token was revoked or expired, or the user deleted) signs the session out; one that
cannot reach Cognito keeps it, and the token works until it expires. Signing out revokes the
refresh token (`RevokeToken`) without waiting for the answer.

An Apple sign-in and an email sign-in with the same address are two different Cognito users
(two `sub`s), so they reach two different Listora accounts. Linking them (a pre sign-up
trigger with `AdminLinkProviderForUser`) is a follow-up.

## What the Cognito user pool needs

This is the specification for staging's and prod's pools (T-30's follow-up); the personal
environment's [owner pool](#the-owner-pool-personal) is the same minus sign-up, Sign in with
Apple, and the managed login domain. Nothing here needs a credential to build or test; it is
needed only to run against a real pool (gates G-AWS and G-Apple).

**User pool**

- Feature plan **Essentials** (or Plus): choice-based authentication and email one-time codes
  need it.
- Sign-in with **email as the username** (`UsernameAttributes: [email]`), case-insensitive
  usernames, `email` auto-verified, self sign-up allowed.
- Sign-in policy: `AllowedFirstAuthFactors: [PASSWORD, EMAIL_OTP]`. Cognito requires
  `PASSWORD` in the list; the app never offers a password.
- Email through **Amazon SES** (`EmailSendingAccount: DEVELOPER`, a verified sending identity
  on Listora's domain), which email one-time codes need and which lifts Cognito's default daily
  email limit. The SES account must be out of the sandbox.
- `PreventUserExistenceErrors: ENABLED`, token revocation enabled (the default), and deletion
  protection on in production.
- The app client's write attributes are `locale` only, so nobody changes their own email
  (which names them to invites and revoking, [invites.md](invites.md)).

**Sign in with Apple identity provider** (`SignInWithApple`)

- From the Apple Developer account: the Team ID, a Services ID (the provider's client id), and
  a Sign in with Apple key (key id and `.p8` private key). Keep the key in Secrets Manager.
- The Services ID's return URL is `https://<auth domain>/oauth2/idpresponse`.
- Authorized scopes `email name`; attribute mapping `email` → `email` and `email_verified` →
  `email_verified`. The API reads the email only when it is verified, and accepts
  `email_verified` as the boolean `true` or the string `"true"`.

**Managed login domain**: a custom domain on Listora's domain (for example
`auth.listora.app`, with an ACM certificate in `us-east-1`) or a Cognito prefix domain.

**App client for the iPhone app**

- A public client (no client secret).
- OAuth: authorization code grant with PKCE, scopes `openid email profile`, callback URL
  `listora://auth/callback`, sign-out URL `listora://auth/signed-out`, identity providers
  `SignInWithApple` (and `COGNITO` for the email flow).
- Explicit auth flows `ALLOW_USER_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH` only.
- Token validity: ID and access tokens 60 minutes, refresh tokens 30 days. The API refuses
  tokens older than a day, so ID and access tokens must stay at or below one day.

**API configuration**: `AUTH_DRIVER=cognito`, `COGNITO_USER_POOL_ID`, and
`COGNITO_CLIENT_IDS` (the app client's id; a later web client is added to the list), which
`containerEnvironment` in `infra/src/containers.ts` sets from the environment's pool (staging
and prod switch when their `signIn` setting does). The API needs outbound HTTPS to
`cognito-idp.<region>.amazonaws.com` for the JWKS.

**Worker configuration**: `COGNITO_USER_POOL_ID` too, for account deletion. The worker's ECS
task role needs `cognito-idp:AdminGetUser` and `cognito-idp:AdminDeleteUser` on the pool, and the worker needs outbound HTTPS to
`cognito-idp.<region>.amazonaws.com`. Without the setting, Cognito deletions wait (and the
worker logs an error on every try) until it is set.

## Account deletion

App Store Review Guideline 5.1.1(v) requires in-app account deletion. The app calls
`DELETE /v1/account` (`deleteAccount` in the contract) after asking the person to confirm. The
deletion must complete without the app, so the API does everything that needs only the
database at once, and leaves the rest to a job:

1. **The API, in one transaction:** deletes the account with all of its data (every tenant
   table cascades from `account`) and the user; records the identity in `deleted_identity`;
   leaves a minimal tombstone in `account_deletion` (the identity's SHA-256, the provider's
   username for it, and, in `account_deletion_grant`, the still-encrypted OAuth tokens of each
   API connection the marketplace has not revoked yet); and enqueues the tombstone's
   `account_deletion` job in Graphile Worker. Either all of it commits or none of it does, so
   any error (a retryable `500` or `503` included) means nothing was deleted, and the app
   retries with the same token. The tombstone also lists the stored objects the deleted rows
   named and the account's key prefixes. After the commit, the API deletes the stored objects
   of the account's photos, uploads, and automation screenshots (a failure is logged: the job
   deletes them again) and answers `200`.
2. **The worker's job** (`completeAccountDeletion` in `packages/accounts/src/job.ts`), until
   it is done:
   - deletes the person at the identity provider: for Cognito, `AdminGetUser` first checks that
     the username still belongs to the deleted `sub` (Cognito reuses a Sign in with Apple
     user's name, `SignInWithApple_<Apple id>`, when the person signs in again, so a repeated
     run must never delete by name alone), then `AdminDeleteUser`. A user that is already gone,
     or whose name now belongs to a newer user, counts as deleted. Dev users exist only as
     signed tokens, so the API records a dev deletion as done at once, and signing in again
     needs no worker.
   - asks each pending grant's marketplace to revoke Listora's access, through the
     `MarketplaceAccessRevoker`: `OAuthGrantRevoker` (`@listora/connections`) opens the grant's
     tokens in the token vault and calls the marketplace's revocation endpoint (eBay's
     `token/revoke`; Depop's joins it in T-24). A confirmed revocation deletes the grant's tokens
     at once. After 7 days the job gives up on the rest: it deletes their tokens too and records
     them as `manual` (the log line says which marketplaces the seller must revoke themselves).
     A marketplace the worker cannot revoke with (no OAuth client or no token vault) always
     ends this way.
   - deletes every stored object of the account (the ones the rows named, and everything under
     `uploads/<account>/`, `photos/<account>/`, and `automation/<account>/`) and reads each back
     until storage no longer has it;
   - checks that no row anywhere still references the deleted account or user (every foreign
     key to `account` and `app_user`, read from the catalog), then writes the deletion's
     completion record (`deletion_record`, without personal data) and deletes the tombstone in
     one transaction. While anything is open, it runs again later (after 1 m, 5 m, 15 m, 1 h,
     3 h, then every 6 h; revocations get a last try when the 7 days end), and a deletion still
     open after 8 days is overdue: it logs an error on every run and raises the
     `deletion-overdue` alarm ([privacy.md](privacy.md)).

   Each step's result is committed before the next one, and each step is safe to repeat, so a
   crash or a database failure between steps only means the next run (Graphile retries a job
   that failed) repeats the step that was not recorded.

The response lists every API connection by marketplace (and the seller's name there), with
`revoked: true` only when the marketplace had confirmed it before the deletion. Every entry
with `revoked: false` names a marketplace whose access the person must revoke manually: the
app lists them and tells the person to remove Listora in each one's settings, since the job's
later outcome never reaches the app (Listora keeps no record of the deleted person: the
completion record has only counts and outcomes). In the app it is Settings > Delete account (shown while someone is signed in,
`AccountDeletionModel` in `SettingsFeature`): it says what deleting removes and keeps, asks to
confirm, then signs out and lists these marketplaces. A `401` answer means an earlier try already
deleted the account, so it reads as deleted too; any other error deletes nothing and can be
tried again.

A token stays cryptographically valid until it expires, and until the job has deleted the
Cognito user, Cognito can still issue new ones (on a refresh, or a new sign-in). The tenancy
guard therefore refuses to provision a user (`401`) for a token of an identity whose deletion
still waits for the identity provider, or whose deletion happened at or after the token was
issued: when the job deletes the user, it moves `deleted_at` to that moment. The guard checks
this inside the provisioning transaction, after taking the advisory lock every deletion of the
identity takes, so a deletion that commits meanwhile cannot be missed. A later sign-in works
and gets a new, empty account (for Cognito it is a new user with a new `sub`).
`deleted_identity` and the tombstone store only a SHA-256 of the subject (the dev subject is an
email address), and `deleted_identity` rows older than 48 hours are purged by later deletions,
since every token issued before the provider deleted the user has expired by then.

A retry after a lost success response gets `401`, which means the account is gone; so does a
second deletion that raced the first.

An owner can delete their account only while they are its only member (`403 forbidden`
otherwise). A non-owner member's deletion removes only their user and membership (and the job
deletes them at the identity provider).

**Not covered yet (follow-up):**

- **Apple token revocation.** Apple asks apps that offer Sign in with Apple to revoke the
  person's Apple tokens through its REST API when they delete their account. With Cognito
  federation, Cognito holds the Apple tokens and `AdminDeleteUser` does not revoke them. This
  needs a decision at G-Apple: either native Sign in with Apple in the app, with the API
  exchanging the authorization code and keeping the Apple refresh token so it can revoke it,
  or confirmation that the Cognito flow is acceptable.

## Data

The tenancy tables (`account`, `app_user`, `membership`) are in
[architecture.md](../architecture.md#6-data-model).

- **Deleted identities:** `deleted_identity` (the SHA-256 of each identity whose account was
  deleted and when, so its earlier tokens are refused; its only timestamp is `deleted_at`, and
  later deletions purge rows older than 48 hours).
- **Account deletion:** `account_deletion` (the tombstone of a committed deletion whose job
  has not finished: the identity's SHA-256 and provider username, attempts) and
  `account_deletion_grant` (the deleted account's marketplace grants still to revoke, with
  their encrypted tokens only while pending), and `account_deletion_object` (stored objects
  still to delete). The job deletes the tombstone when it is done, and leaves a
  `deletion_record` ([privacy.md](privacy.md#data)). The tombstone's `account_id` and `user_id`
  say what the job checks.

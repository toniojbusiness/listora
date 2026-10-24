# Sign-in and account deletion

How people sign in to Listora and delete their account (plan task T-31, decision D10). The
API side is in `apps/api/src/auth/` and `apps/api/src/account/`; the overview is in
[architecture.md](architecture.md#the-api-appsapi).

## Drivers

`AUTH_DRIVER` picks how the API verifies bearer tokens. Every `/v1` request needs one.

| Driver    | Used for                    | How a person signs in                                                     |
| --------- | --------------------------- | ------------------------------------------------------------------------- |
| `dev`     | Local development and tests | A one-time code printed to the API log (see the README)                   |
| `cognito` | Staging and production      | The app signs in with the Cognito user pool and sends the pool's ID token |

The API never sees a password or an Apple credential. With `cognito`, the app talks to
Cognito directly, and the API only verifies the tokens Cognito issued.

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

## The flows the app uses

Both flows end with the app holding the pool's ID, access, and refresh tokens. The app keeps
them in the Keychain and refreshes them with the refresh token (`REFRESH_TOKEN_AUTH`).

- **Sign in with Apple** goes through Cognito's managed login (hosted UI) as a federated
  identity provider. The app opens
  `https://<auth domain>/oauth2/authorize?identity_provider=SignInWithApple&response_type=code&client_id=<app client>&redirect_uri=listora://auth/callback&scope=openid+email+profile&code_challenge=...&code_challenge_method=S256`
  in `ASWebAuthenticationSession`, which goes straight to Apple's sheet, and exchanges the
  returned code (with the PKCE verifier) at `https://<auth domain>/oauth2/token`.
- **Email one-time code** uses Cognito's passwordless sign-in (choice-based authentication).
  A new person calls `SignUp` with only their email (no password) and `ConfirmSignUp` with the
  emailed code; the returned session signs them in through `InitiateAuth` with
  `AuthFlow=USER_AUTH`. A returning person calls `InitiateAuth` with `AuthFlow=USER_AUTH` and
  `PREFERRED_CHALLENGE=EMAIL_OTP`, then `RespondToAuthChallenge` with `EMAIL_OTP_CODE`.

An Apple sign-in and an email sign-in with the same address are two different Cognito users
(two `sub`s), so they reach two different Listora accounts. Linking them (a pre sign-up
trigger with `AdminLinkProviderForUser`) is a follow-up.

## What the Cognito user pool needs

This is the specification for the infrastructure task (T-30 or its follow-up). Nothing here
needs a credential to build or test; it is needed only to run against a real pool (gates G-AWS
and G-Apple).

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

**API configuration**: `AUTH_DRIVER=cognito` (`containerEnvironment` in `infra/src/containers.ts`
still sets `dev` until the pool exists), `COGNITO_USER_POOL_ID`, and
`COGNITO_CLIENT_IDS` (the app client's id; a later web client is added to the list). The ECS
task role needs `cognito-idp:AdminDeleteUser` on the pool for account deletion. The API needs
outbound HTTPS to `cognito-idp.<region>.amazonaws.com` for the JWKS and the admin API.

## Account deletion

App Store Review Guideline 5.1.1(v) requires in-app account deletion. The app calls
`DELETE /v1/account` (`deleteAccount` in the contract) after asking the person to confirm. The
API, in this order:

1. Asks each marketplace with an API connection to revoke Listora's access, through the
   `MarketplaceAccessRevoker` the marketplace adapters provide (eBay in T-16, Depop in T-24).
   A confirmed revocation is recorded at once. The response lists every API connection with
   `revoked: true` only when the marketplace confirmed it; for the others the app tells the
   person to remove Listora in that marketplace's settings. Until an adapter can revoke, every
   connection that holds tokens is reported as not revoked.
2. Deletes the person from the identity provider (`AdminDeleteUser` for Cognito, a no-op for
   dev), so they cannot sign in to the deleted account again. A user that is already gone
   counts as deleted. If this fails, nothing in the database is deleted yet, and the answer
   is a retryable `503`.
3. In one transaction, deletes the account with all of its data (every tenant table
   cascades from `account`) and the user, and records the identity in `deleted_identity`.
4. After the commit, deletes the stored objects of the account's photos (derived images and
   any upload not yet processed) and of uploads no photo used. A failed object deletion is
   logged and does not fail the request, as for `deleteItem`: no row references the object
   any more.

A token stays cryptographically valid until it expires, so the tenancy guard refuses a token
whose identity was deleted at or after the token was issued (`401`), instead of provisioning a
new account for it. A later sign-in works and gets a new, empty account (for Cognito it is a
new user with a new `sub`). `deleted_identity` stores only a SHA-256 of the subject (the dev
subject is an email address), and rows older than 48 hours are purged by later deletions,
since every token issued before the deletion has expired by then.

If step 3 fails after step 2, the same token still verifies, so the app's retry finds the
Cognito user already gone and finishes the deletion. A retry after a lost success response
gets `401`, which means the account is gone.

An owner can delete their account only while they are its only member (`403 forbidden`
otherwise). A non-owner member's deletion removes only their user and membership.

**Not covered yet (follow-up):**

- **Apple token revocation.** Apple asks apps that offer Sign in with Apple to revoke the
  person's Apple tokens through its REST API when they delete their account. With Cognito
  federation, Cognito holds the Apple tokens and `AdminDeleteUser` does not revoke them. This
  needs a decision at G-Apple: either native Sign in with Apple in the app, with the API
  exchanging the authorization code and keeping the Apple refresh token so it can revoke it,
  or confirmation that the Cognito flow is acceptable.

# Invites

How someone other than the owner gets their own Listora: the owner invites them in Settings,
and they sign up with the invite's code and their own email. Each person's account is fully
separate (its own inventory, linked marketplaces, sales, and settings), like any other tenant
([architecture.md](../architecture.md#4-api-conventions)). The API side is in
`apps/api/src/invites/` and the tenancy guard (`apps/api/src/tenancy.ts`), the identity
provider's side in `packages/accounts/src/invitees.ts`, and the app's in `SignInFeature`
(`InviteSignUpModel`, `InviteSignUpView`) and `SettingsFeature/Invites` (Settings > People).

## How it works

1. **The owner invites.** Settings > People > Invite someone (`createInvite`): an optional name
   ("Who is it for?") and how long the code works (1, 7, or 30 days, or never; 7 by default).
   The answer has the one-time code, for example `K7QD-3M9P-XW2T-H8RA` (16 characters of
   Crockford's base32, 80 random bits), an app link `listora://invite/<code>`, and a message to
   share; the app opens the share sheet with it. The code is shown only then: the server keeps
   its SHA-256 and its last four characters (`codeHint`), so a lost code means revoking the
   invite and creating another. An account has at most 20 invites nobody has used yet.
2. **The invitee redeems it.** In the app, the welcome screen's "Sign up with an invite" (or the
   link) opens the sign-up: the code and their own email. `redeemInvite` needs no sign-in (the
   code is the credential). It binds the invite to that email in one transaction that locks the
   invite, then creates the person's user at the identity provider (for Cognito
   `AdminCreateUser`: verified, no password, no invitation message, like the owner). It is safe
   to repeat: the same code and email give the same answer. Until the invitee has signed in,
   the same code with another email moves the invite to it (a typo; 5 times at most) and removes
   the user of the old address.
3. **The invitee signs in** with the code emailed to that address, as the owner does
   ([auth.md](auth.md#the-flows-the-app-uses)). Their first signed-in request creates their
   user, a new, empty account (`invited_at` set, SKU prefix from their email), and their
   owner membership, and links the invite to them, in one transaction.

**Who gets an account.** `SIGN_UP=invite` (the personal environment) gives an account at a
first sign-in only to an email that redeemed an invite, and to `SIGN_UP_OWNER_EMAIL` (the
deploy's owner, so they can sign up again after deleting their account). Anyone else signed in
by the identity provider gets `403` and no account. `SIGN_UP=open` (the default, local
development and tests) gives everyone an account, as before. With Cognito, the pool is a second
gate: self sign-up is off, so the only users are the owner and those who redeemed an invite.

**Who may invite.** Only an account created directly (`account.invited_at` is null: the
owner's, and every account from before invites). An invited person's `listInvites` answers
`canInvite: false` and `createInvite` is `403`, so invites never chain past the owner, and
Settings shows People only to the owner.

**Expiry.** An invite nobody redeemed stops working at `expiresAt` (`409`; the list shows
"Expired"). Once redeemed, it no longer expires.

**Revoking and restoring.** `revokeInvite` on an invite nobody redeemed stops its code. On one
someone redeemed, it turns off their access at once: the identity provider signs them out
everywhere and disables their user (`AdminUserGlobalSignOut`, `AdminDisableUser`), and the
tenancy guard refuses their tokens with `403` from the next request (a token issued earlier
still verifies, so the guard checks the invite on every request). Their account and data are
kept, and `restoreInvite` gives the access back (`AdminEnableUser`). The identity provider is
called first, inside the request's transaction: when it fails, the answer is a retryable `503`
and nothing was revoked, so the app never shows a revocation that did not happen.

**Costs per person.** The AI guards and the automation limits already count per account, and
each person has their own: the daily AI budget (`AI_DAILY_BUDGET_USD`, [ai.md](ai.md)), the
plan quotas in `usage_counter`, and the per-seller runs per hour and day
([automation.md](automation.md)) apply to each person separately, so one person cannot spend
another's budget. The global AI kill switch and the operator's per-account AI blocks
(`npm run admin`) cover every account. A revoked person makes no requests, so they start no new
AI work. Their linked marketplaces are kept on purpose: the background sale checks and the
auto-delist go on protecting their live listings from selling twice, within their run limits.

**Deleting.** An invitee who deletes their account (Settings > Delete account) deletes the
invite with it (its row references their account), so nothing of theirs stays in the owner's
list, and the API removes their address at the identity provider (their user, and in the SES
sandbox their SES identity; the worker's deletion job deletes the user too,
[auth.md](auth.md#account-deletion)). The owner deleting their account deletes their invites;
the people they invited keep their own accounts.

**Guessing.** A code has 80 random bits, and `redeemInvite` refuses every redemption with `429`
once 30 wrong codes arrived within 15 minutes (per API process, in memory).

### Reaching invitees in the SES sandbox

The personal environment's AWS account has SES production access (granted 2026-10-27), so the
pool's codes reach any address and it runs with `INVITE_EMAIL_VERIFICATION=none`
(`ENVIRONMENT_SETTINGS.personal.signIn`): redeeming answers `ready` at once. An account still in
SES's sandbox, which sends only to verified addresses, sets `ses`: redeeming then also makes the
invitee's address an SES email identity (`CreateEmailIdentity`), which emails them a
verification link from Amazon Web Services. Until they click it, `redeemInvite` answers
`status: email_verification_sent` and the app says to open that email first; Continue redeems
again, and once SES reports the address verified the answer is `ready` and the sign-in code is
sent. A link that expired is sent again. With `ses`, the API's task role may create, read, and
delete only email-address identities (`identity/*@*`); with `none` it has no SES rights.

## In the app

- **Welcome screen:** "Sign up with an invite" opens the sign-up (`InviteSignUpView`), and an
  invite link (`listora://invite/<code>`, the app's registered URL scheme) opens it with the
  code filled in. Continue redeems the invite, then the code screen follows as for any sign-in;
  going back from it returns to the sign-up.
- **Settings > People** (`InvitesView`, owner only): the invites, newest first, each with the
  server's status (Not used yet, Expired, Waiting for them to sign in, Active, Revoked, Access
  turned off), the invitee's email once redeemed, and Revoke, Turn off, or Restore as
  `availableActions` allow, each after a confirmation. Invite someone opens the form, then the
  code to share, with Copy code and Share invite.

## Local development

Nothing needs a credential. With the dev driver, redeeming creates no user (dev identities are
signed tokens and any email can request a code), so `SIGN_UP=invite` alone decides who gets an
account, as in production. To try it, set `SIGN_UP=invite` and `SIGN_UP_OWNER_EMAIL` in `.env`,
create an invite as the owner, and redeem it:

```sh
curl -X POST localhost:3000/v1/invite-redemptions -H 'content-type: application/json' \
  -H "idempotency-key: $(uuidgen)" -d '{"code": "K7QD-3M9P-XW2T-H8RA", "email": "maria@example.com"}'
```

Then sign in as that email through `/dev/auth` ([auth.md](auth.md#signing-in-locally)). The
tests use `FakeInviteeDirectory` (`@listora/accounts/testing`) for the identity provider.

## Data

Migration `20261027214618_invites`:

- `account.invited_at`: when the account was created from an invite; null for accounts created
  directly, which are the only ones that may invite.
- `account_invite` (in the inviting account): the code's SHA-256 and last four characters, the
  label, `expires_at`, the redeemed email (`claimed_email`, lowercase, unique across every
  invite) and when, how often it moved (`email_changes`), the invitee's user and account and
  when they joined, and `revoked_at`. The invitee's account belongs to them, not to the
  inviter, so `invitee_account_id` and `invitee_user_id` are the one place a tenant table
  references another tenant's rows; deleting the invitee's account deletes the row.

## Follow-ups

- With `INVITE_EMAIL_VERIFICATION=ses`, an invitee's SES identity stays if the API cannot remove
  it right after their account is deleted (it only logs).
- A revoked person's data stays until the owner restores them or they are deleted by an
  operator; a way for the owner to delete a revoked person's account is not built yet.
- Universal links (an `https://` invite link that opens the app, or the App Store when it is
  not installed) need Listora's domain.

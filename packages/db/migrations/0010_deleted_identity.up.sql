-- In-app account deletion (plan task T-31). `DELETE /v1/account` deletes the person's data (and,
-- for an owner, the account with everything in it) in one transaction, and in that same
-- transaction leaves the minimal tombstone below and enqueues its `account_deletion` job. The
-- worker's job finishes what needs outside services: it deletes the person at the identity
-- provider and asks each marketplace to revoke Listora's access, retrying until done, and then
-- deletes the tombstone. So the deletion completes without the client.
--
-- A bearer token issued before the deletion stays valid until it expires (Cognito tokens are
-- verified locally, without asking Cognito). The API refuses to provision a new, empty account
-- for such a token: a token of an identity in `deleted_identity` issued at or before
-- `deleted_at` is rejected, and so is every token of an identity whose tombstone still waits for
-- the provider to delete the user (until then the provider can issue new tokens). A token issued
-- after the provider deleted the user is a new sign-in and works.
--
-- Subjects are stored only as their SHA-256, so no email address (the dev driver's subject)
-- outlives the deletion. Like `app_user`, an identity is global, so these tables have no
-- `account_id`.

-- A `deleted_identity` row matters only while a token issued before the deletion can still be
-- valid (at most a day), so later deletions purge rows older than the retention period
-- (`@listora/accounts`).
create table deleted_identity (
  auth_provider text not null check (auth_provider in ('dev', 'cognito')),
  auth_subject_sha256 bytea not null check (octet_length(auth_subject_sha256) = 32),
  -- Moved forward when the provider confirms the user is gone, and when the same identity
  -- deletes a later account (dev sign-ins reuse the email).
  deleted_at timestamptz not null default now(),
  primary key (auth_provider, auth_subject_sha256)
);

create index deleted_identity_deleted_at_idx on deleted_identity (deleted_at);

-- A committed deletion whose job has not finished yet.
create table account_deletion (
  id uuid primary key default uuidv7(),
  auth_provider text not null check (auth_provider in ('dev', 'cognito')),
  auth_subject_sha256 bytea not null check (octet_length(auth_subject_sha256) = 32),
  -- The name the provider's admin API deletes the user by (Cognito's username); null for dev
  -- users, who exist only as signed tokens.
  provider_username text check (char_length(provider_username) between 1 and 255),
  requested_at timestamptz not null default now(),
  -- When the provider confirmed the user is gone (for dev, at once: dev users exist only as
  -- signed tokens).
  identity_deleted_at timestamptz,
  -- Runs of the job that left work for later; the next run waits longer.
  attempts integer not null default 0 check (attempts >= 0),
  check (auth_provider = 'dev' or provider_username is not null)
);

create index account_deletion_identity_idx on account_deletion (auth_provider, auth_subject_sha256);

-- The deleted account's marketplace grants that Listora still has to revoke. Each keeps the
-- connection's encrypted OAuth tokens only while its revocation is pending: they are deleted
-- once the marketplace confirms it (`revoked`) or the job gives up (`manual`: the seller must
-- remove Listora in the marketplace's settings).
create table account_deletion_grant (
  deletion_id uuid not null references account_deletion (id) on delete cascade,
  -- The deleted `marketplace_connection`'s id, for logs.
  connection_id uuid not null,
  marketplace marketplace_id not null,
  token_ciphertext bytea,
  outcome text not null default 'pending' check (outcome in ('pending', 'revoked', 'manual')),
  primary key (deletion_id, connection_id),
  check ((outcome = 'pending') = (token_ciphertext is not null))
);

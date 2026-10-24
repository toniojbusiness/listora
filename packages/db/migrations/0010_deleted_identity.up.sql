-- In-app account deletion (plan task T-31). Deleting an account also deletes its user, but a
-- bearer token issued before the deletion stays valid until it expires (Cognito tokens are
-- verified locally, without asking Cognito). The API refuses such a token instead of
-- provisioning a new, empty account for it: a token of a listed identity issued at or before
-- `deleted_at` is rejected. A token issued later is a new sign-in and works.
--
-- The subject is stored only as its SHA-256, so no email address (the dev driver's subject)
-- outlives the deletion. A row matters only while a token issued before the deletion can still
-- be valid (at most a day), so later deletions purge rows older than the retention period
-- (`deleteAccount` in apps/api). Like `app_user`, an identity is global, so the table has no
-- `account_id`.
create table deleted_identity (
  auth_provider text not null check (auth_provider in ('dev', 'cognito')),
  auth_subject_sha256 bytea not null check (octet_length(auth_subject_sha256) = 32),
  -- Moved forward when the same identity deletes a later account (dev sign-ins reuse the email).
  deleted_at timestamptz not null default now(),
  primary key (auth_provider, auth_subject_sha256)
);

create index deleted_identity_deleted_at_idx on deleted_identity (deleted_at);

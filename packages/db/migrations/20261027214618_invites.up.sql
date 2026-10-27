-- Invite-based sign-up (docs/features/invites.md): the owner invites a person, who signs up with
-- their own email and gets their own, separate account.
--
-- `account.invited_at`: when the account was created from an invite. Accounts created directly
-- (the owner's, and every account before this migration) have none, and only they may invite.
alter table account add column invited_at timestamptz;

-- `account_invite`: one invite, in the inviting account. Only the SHA-256 of its code is kept
-- (the code is shown once, when it is created) and the code's last four characters, so the
-- owner can tell invites apart. Redeeming it binds it to the invitee's email (`claimed_email`,
-- one invite per address); their first sign-in creates their account (`invitee_account_id`).
-- Revoking an invite before it is redeemed stops it; after, it removes the person's access.
-- The invitee's account belongs to them, so it references back from here and deleting it
-- deletes this row (and the email with it).
create table account_invite (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  code_sha256 bytea not null unique check (octet_length(code_sha256) = 32),
  code_hint text not null check (code_hint ~ '^[0-9A-Z]{4}$'),
  label text check (char_length(label) between 1 and 100),
  expires_at timestamptz,
  claimed_email text unique
    check (char_length(claimed_email) between 3 and 320 and claimed_email = lower(claimed_email)),
  claimed_at timestamptz,
  -- How often the invitee changed the email (a typo) before signing in; bounded by the API.
  email_changes integer not null default 0 check (email_changes >= 0),
  invitee_user_id uuid unique references app_user (id) on delete cascade,
  invitee_account_id uuid unique references account (id) on delete cascade,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((claimed_email is null) = (claimed_at is null)),
  check ((accepted_at is null) = (invitee_account_id is null)),
  check ((invitee_account_id is null) = (invitee_user_id is null)),
  check (accepted_at is null or claimed_at is not null),
  check (invitee_account_id is null or invitee_account_id <> account_id)
);

create index account_invite_account_created on account_invite (account_id, created_at desc);

create trigger account_invite_set_updated_at
  before update on account_invite
  for each row execute function set_updated_at();

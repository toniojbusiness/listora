-- Marketplace account connection over OAuth, the token vault, and connection health (plan task
-- T-16, eBay first).
--
-- Connecting is two requests: `startConnectionAuthorization` (signed in) stores an attempt with
-- the SHA-256 of a random single-use `state` and returns the marketplace's consent URL (kept
-- only in that response, which its idempotency record replays for 24 hours); the marketplace
-- then sends the user's browser to the public callback with that `state`, which is the only
-- thing binding the callback to the person who started, for ten minutes. The callback exchanges the code
-- on the server, encrypts the tokens (envelope encryption, `@listora/connections`), and records
-- the result on the attempt, which the app reads back (it never trusts the redirect alone).
-- Connecting keeps at most one connection per account and marketplace (the API addresses
-- connections by marketplace): it locks the account row and reuses the existing connection.

alter table marketplace_connection
  -- When the marketplace issued the current grant (the code exchange). A revocation notice dated
  -- before it is about an earlier grant and changes nothing.
  add column granted_at timestamptz,
  -- `last_error` is the user-readable message of the latest problem; these say what it was and
  -- when. All three are set together and cleared together, when a check succeeds again.
  add column last_error_code text check (last_error_code ~ '^[a-z][a-z0-9_]*$'),
  add column last_error_at timestamptz,
  add constraint marketplace_connection_error_complete
    check ((last_error is null) = (last_error_code is null)
      and (last_error_code is null) = (last_error_at is null)),
  -- A revoked grant is worthless, so its tokens are deleted with the revocation.
  add constraint marketplace_connection_revoked_holds_no_token
    check (status <> 'revoked' or token_ciphertext is null);

-- One attempt to connect a marketplace account.
create table connection_authorization (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  -- Who started it: the callback acts for them.
  user_id uuid not null references app_user (id) on delete cascade,
  marketplace marketplace_id not null,
  -- SHA-256 of the `state` sent to the marketplace; this table never holds the state itself.
  state_sha256 bytea not null unique check (octet_length(state_sha256) = 32),
  -- When the callback claimed the attempt: the state is single-use, so a second callback with
  -- it changes nothing.
  callback_at timestamptz,
  -- `pending` past `expires_at` reads as expired; the callback refuses it.
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  -- The connection a completed attempt connected (cleared if that connection is deleted).
  connection_id uuid,
  -- A contract error code and a user-readable message; set exactly when `failed`.
  failure_code text check (failure_code ~ '^[a-z][a-z0-9_]*$'),
  failure_message text check (char_length(failure_message) between 1 and 1000),
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  foreign key (account_id, connection_id, marketplace)
    references marketplace_connection (account_id, id, marketplace)
    on delete set null (connection_id),
  constraint connection_authorization_completed_has_time
    check ((status = 'pending') = (completed_at is null)),
  constraint connection_authorization_failed_has_reason
    check ((status = 'failed') = (failure_code is not null)
      and (failure_code is null) = (failure_message is null))
);

create index connection_authorization_account_idx
  on connection_authorization (account_id, created_at);

create trigger connection_authorization_set_updated_at
  before update on connection_authorization
  for each row execute function set_updated_at();

-- Revocation notices name the marketplace's user, not the account.
create index marketplace_connection_external_user_idx
  on marketplace_connection (marketplace, external_user_id)
  where external_user_id is not null;

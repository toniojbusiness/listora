-- Browser automation (decision D1, revised 2026-10-24; docs/features/automation.md).
--
-- Poshmark, Mercari, and Depop (until its partner API is granted) are automated in the cloud by
-- the browser runner, acting in the session the seller logs into from the iPhone app. A
-- connection in `automation` mode keeps that session (cookies only, never a password) in
-- token_ciphertext, encrypted like OAuth tokens.

alter table marketplace_connection drop constraint marketplace_connection_mode_check;
alter table marketplace_connection add constraint marketplace_connection_mode_check
  check (mode in ('api', 'assisted', 'automation'));

comment on column marketplace_connection.token_ciphertext is
  'The connection''s credential, encrypted (KMS envelope in production): OAuth tokens for api, the browser session cookies for automation. Never a password; assisted connections hold none.';

-- Bumped by every write of an automation connection's session (link, rotation, relink, a
-- rejected session), so a runner that loaded an older session can never overwrite a newer one.
alter table marketplace_connection
  add column credential_version integer not null default 0 check (credential_version >= 0);

-- A working automation connection holds a session; one that needs relinking (the marketplace
-- rejected the session, or showed a check Listora must not pass) holds none: a rejected
-- session is never kept or tried again.
alter table marketplace_connection add constraint marketplace_connection_automation_session
  check (mode <> 'automation' or (status in ('connected', 'degraded')) = (token_ciphertext is not null));

-- One row per browser session the runner opened for a connection: an operation step, a sale
-- check, or a health check. It is the per-connection rate limit's count, and the record of what
-- automation did and where it stopped. A run that met a CAPTCHA, a bot check, or a login check
-- says which; a failed one names its step and may keep a redacted screenshot (a private
-- storage key, deleted with the account).
create table automation_run (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  connection_id uuid not null,
  marketplace marketplace_id not null,
  purpose text not null check (purpose in ('operation', 'sale_check', 'health')),
  -- The adapter's name for what it ran, for example `end` or `read listing`.
  script text not null check (char_length(script) between 1 and 100),
  operation_id uuid,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text check (outcome in ('succeeded', 'failed', 'timeout', 'challenge', 'canceled')),
  challenge_kind text
    check (challenge_kind in ('captcha', 'bot_check', 'login_challenge', 'session_rejected', 'unexpected_page')),
  failed_step text check (char_length(failed_step) between 1 and 100),
  error_code text check (char_length(error_code) between 1 and 100),
  screenshot_key text check (char_length(screenshot_key) between 1 and 1024),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  constraint automation_run_finished_has_outcome check ((finished_at is null) = (outcome is null)),
  constraint automation_run_challenge_has_kind
    check ((outcome = 'challenge') = (challenge_kind is not null)),
  -- Only an operation's runs name it (its read-backs included).
  constraint automation_run_operation_purpose check (purpose = 'operation' or operation_id is null),
  foreign key (account_id, connection_id, marketplace)
    references marketplace_connection (account_id, id, marketplace) on delete cascade,
  foreign key (account_id, operation_id) references marketplace_operation (account_id, id)
    on delete cascade
);

create index automation_run_connection_idx on automation_run (account_id, connection_id, started_at);
create index automation_run_operation_idx on automation_run (account_id, operation_id)
  where operation_id is not null;
create index automation_run_screenshot_idx on automation_run (account_id)
  where screenshot_key is not null;

-- When the runner next checks an automation connection for sales. The interval adapts to the
-- seller's own sales history on that marketplace, within configured bounds; a forwarded sale
-- email moves the next check to now.
create table sale_check_schedule (
  account_id uuid not null references account (id) on delete cascade,
  connection_id uuid not null,
  marketplace marketplace_id not null,
  next_check_at timestamptz not null,
  -- Why the next check is due then: the adaptive schedule, a forwarded sale email, a retry after
  -- a check that failed, or a connection that was just linked.
  next_reason text not null check (next_reason in ('scheduled', 'email', 'retry', 'linked')),
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_outcome text check (last_outcome in ('succeeded', 'failed', 'challenge')),
  -- The newest sale time the last successful check covered; the next one looks back from here.
  checked_through timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, connection_id),
  constraint sale_check_schedule_finished_has_outcome
    check ((last_finished_at is null) = (last_outcome is null)),
  foreign key (account_id, connection_id, marketplace)
    references marketplace_connection (account_id, id, marketplace) on delete cascade
);

create index sale_check_schedule_due_idx on sale_check_schedule (next_check_at);

create trigger automation_run_set_updated_at
  before update on automation_run
  for each row execute function set_updated_at();

create trigger sale_check_schedule_set_updated_at
  before update on sale_check_schedule
  for each row execute function set_updated_at();

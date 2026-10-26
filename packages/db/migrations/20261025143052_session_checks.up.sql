-- Session checks (decision D1; docs/features/marketplace-linking.md).
--
-- When the seller links a marketplace from the iPhone app, Listora stores the session and then
-- asks the browser runner for one quick read-only check that the marketplace accepts it. The
-- app shows the marketplace as linked only after that check passed. One row per automation
-- connection: a relink starts a new check (a new check_id) and replaces the old one.
create table session_check (
  account_id uuid not null references account (id) on delete cascade,
  connection_id uuid not null,
  marketplace marketplace_id not null,
  -- The link this check is for; the runner's job names it, so a job for an older link never
  -- records its result on a newer one.
  check_id uuid not null default uuidv7(),
  status text not null default 'pending' check (status in ('pending', 'passed', 'failed')),
  -- Runner attempts so far: a check the marketplace could not answer is tried a few times.
  attempts integer not null default 0 check (attempts >= 0),
  failure_code text check (char_length(failure_code) between 1 and 100),
  -- User-readable and names the marketplace.
  failure_message text check (char_length(failure_message) between 1 and 1000),
  -- When the session this check is for was linked.
  requested_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, connection_id),
  constraint session_check_finished check ((status = 'pending') = (finished_at is null)),
  constraint session_check_failure
    check ((status = 'failed') = (failure_code is not null and failure_message is not null)),
  foreign key (account_id, connection_id, marketplace)
    references marketplace_connection (account_id, id, marketplace) on delete cascade
);

create trigger session_check_set_updated_at
  before update on session_check
  for each row execute function set_updated_at();

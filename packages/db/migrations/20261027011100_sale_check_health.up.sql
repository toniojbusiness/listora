-- Activity and sale-check health (docs/features/activity.md).
--
-- Every sale check is recorded (`sale_check_run`): when it ran and where, what it read, how many
-- sold orders it saw, what it handed to the sale intake, and why it failed. Each connection's
-- schedule keeps the health those records add up to, so a marketplace whose sale checks fail or
-- stop running is shown on Today and announced, never silent. A read-only read of the seller's
-- sold history (`sale_history` on the phone) proves a marketplace's sale check reads real sold
-- items without acting on any. Each browser session records its steps and how long each took.

-- The steps of a browser session, in order: `[{"name": "open the sold tab", "ms": 1840}, ...]`.
alter table automation_run
  add column steps jsonb check (steps is null or jsonb_typeof(steps) = 'array');

create table sale_check_run (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  connection_id uuid not null,
  marketplace marketplace_id not null,
  -- `scheduled`: a sale check, which hands each new sold order to the sale intake. `history`: a
  -- read-only read of the seller's sold history, which hands nothing over and changes nothing.
  kind text not null check (kind in ('scheduled', 'history')),
  -- Why a scheduled check ran (the schedule's reason); none for a history read.
  reason text check (reason in ('scheduled', 'email', 'retry', 'linked')),
  host text not null check (host in ('runner', 'phone')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text check (outcome in ('succeeded', 'failed', 'challenge')),
  -- The check read the orders sold since then (null: every order the pages show).
  since timestamptz,
  orders_seen integer check (orders_seen >= 0),
  items_seen integer check (items_seen >= 0),
  -- Orders it handed to the sale intake for the first time (never for a history read).
  new_orders integer check (new_orders >= 0),
  newest_sold_at timestamptz,
  oldest_sold_at timestamptz,
  -- What it read, at most 100 orders, newest first: each order's id and sale time and its
  -- items' listing id, title, and price. Never a buyer's name or address.
  orders jsonb not null default '[]' check (jsonb_typeof(orders) = 'array'),
  error_code text check (char_length(error_code) between 1 and 100),
  -- User-readable, names the marketplace.
  error_message text check (char_length(error_message) between 1 and 500),
  -- The browser session that read the orders, while its record is kept.
  automation_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  constraint sale_check_run_finished check ((finished_at is null) = (outcome is null)),
  constraint sale_check_run_reason check ((kind = 'scheduled') = (reason is not null)),
  constraint sale_check_run_failure
    check ((outcome is null or outcome = 'succeeded') = (error_code is null)),
  constraint sale_check_run_counts check (
    (outcome = 'succeeded') = (orders_seen is not null and items_seen is not null
      and new_orders is not null)),
  foreign key (account_id, connection_id, marketplace)
    references marketplace_connection (account_id, id, marketplace) on delete cascade,
  foreign key (account_id, automation_run_id) references automation_run (account_id, id)
    on delete set null (automation_run_id)
);

create index sale_check_run_connection_idx
  on sale_check_run (account_id, connection_id, started_at);
create index sale_check_run_marketplace_idx
  on sale_check_run (account_id, marketplace, started_at);
-- The retention job deletes the oldest first.
create index sale_check_run_started_idx on sale_check_run (started_at);

create trigger sale_check_run_set_updated_at
  before update on sale_check_run
  for each row execute function set_updated_at();

-- The health the checks add up to. `failing`: the last checks in a row failed. `overdue`: the
-- check that was due has not run for longer than the grace. `alerted_at` is when the seller was
-- told about this problem; a check that works ends it.
alter table sale_check_schedule
  add column last_succeeded_at timestamptz,
  add column failures_in_a_row integer not null default 0 check (failures_in_a_row >= 0),
  add column last_error_code text check (char_length(last_error_code) between 1 and 100),
  add column last_error_message text check (char_length(last_error_message) between 1 and 500),
  add column health text not null default 'healthy'
    check (health in ('healthy', 'failing', 'overdue')),
  add column unhealthy_since timestamptz,
  add column alerted_at timestamptz,
  add constraint sale_check_schedule_unhealthy_since
    check ((health = 'healthy') = (unhealthy_since is null)),
  add constraint sale_check_schedule_alerted check (health <> 'healthy' or alerted_at is null);

create index sale_check_schedule_unhealthy_idx on sale_check_schedule (account_id)
  where health <> 'healthy';

-- The check that saw a sale, while its record is kept.
alter table sale
  add column sale_check_run_id uuid,
  add constraint sale_sale_check_run foreign key (account_id, sale_check_run_id)
    references sale_check_run (account_id, id) on delete set null (sale_check_run_id);

-- A read of the seller's sold history waits for the phone like a sale check.
alter table phone_work drop constraint phone_work_purpose_check;
alter table phone_work add constraint phone_work_purpose_check
  check (purpose in ('operation', 'session_check', 'sale_check', 'sale_history'));
create unique index phone_work_sale_history on phone_work (account_id, connection_id)
  where purpose = 'sale_history';

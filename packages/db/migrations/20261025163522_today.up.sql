-- The Today screen and its morning summary (docs/features/today.md).
--
-- The Today summary is computed on every app open from the tables that already hold the truth
-- (sales, delist runs, connections, listings, items), so it adds no table of its own; this index
-- keeps its read of open delist runs cheap (its sales read uses the profit dashboard's
-- `sale_sold_at_idx`).
create index delist_run_open_idx on delist_run (account_id, created_at) where status <> 'completed';

-- The morning summary notification, one setting per account (the notification goes to every
-- device signed in to the account). `local_time` is wall-clock time in `time_zone`, an IANA name
-- the app reports; with no time zone yet the summary is never sent. `last_sent_on` is the local
-- date of the latest summary, so each day gets at most one.
create table today_summary_setting (
  account_id uuid primary key references account (id) on delete cascade,
  enabled boolean not null default true,
  local_time time(0) not null default '08:00',
  time_zone text check (char_length(time_zone) between 1 and 64),
  last_sent_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint today_summary_setting_whole_minutes check (date_trunc('minute', local_time) = local_time)
);

create index today_summary_setting_enabled_idx on today_summary_setting (account_id)
  where enabled and time_zone is not null;

create trigger today_summary_setting_set_updated_at
  before update on today_summary_setting
  for each row execute function set_updated_at();

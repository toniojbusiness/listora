-- Background read health (docs/features/read-health.md): whether each connection's background
-- reads (sale checks, listing imports, offer checks) work, one row per connection and read, so
-- the owner is emailed when one fails again and again and an admin view lists when each last
-- worked. Only the owner sees it; the seller's screens never do.
create table background_read_health (
  account_id uuid not null references account (id) on delete cascade,
  connection_id uuid not null,
  marketplace marketplace_id not null,
  read text not null check (read in ('sale_check', 'listing_import', 'offer_check')),
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  failures_in_a_row integer not null default 0 check (failures_in_a_row >= 0),
  -- The first failure since the read last worked; null while it works.
  failing_since timestamptz,
  -- The last failure: its code, the step it stopped at, and the reader's own words for it
  -- (sanitized: no page text, nothing typed, no URL path). For the owner only.
  last_error_code text check (char_length(last_error_code) between 1 and 100),
  last_error_step text check (char_length(last_error_step) between 1 and 200),
  last_error_detail text check (char_length(last_error_detail) between 1 and 500),
  -- When the owner was emailed about this run of failures; a read that works ends it.
  owner_alerted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, connection_id, read),
  constraint background_read_health_failing
    check ((failures_in_a_row = 0) = (failing_since is null)),
  foreign key (account_id, connection_id, marketplace)
    references marketplace_connection (account_id, id, marketplace) on delete cascade
);

-- The alert task looks for failing reads the owner has not been told about.
create index background_read_health_failing_idx
  on background_read_health (failing_since) where failing_since is not null;

create trigger background_read_health_set_updated_at
  before update on background_read_health
  for each row execute function set_updated_at();

-- Listing refresh (docs/features/listing-refresh.md): Listora refreshes a live listing that has
-- gone a while without selling, through the marketplace's own normal mechanism (Poshmark's share
-- to followers, Mercari's and Depop's edit and save), never a delete and repost.
--
-- A refresh is a marketplace operation like any other change, confirmed only by a read-back,
-- queued by the worker's schedule (`auto_refresh`), never by a seller's tap.
alter table marketplace_operation
  drop constraint marketplace_operation_kind_check,
  add constraint marketplace_operation_kind_check
    check (kind in ('create', 'revise', 'price', 'end', 'relist', 'mark_sold', 'verify', 'refresh')),
  drop constraint marketplace_operation_origin_check,
  add constraint marketplace_operation_origin_check
    check (origin in ('user', 'auto_delist', 'reprice_rule', 'auto_refresh'));

-- How often the account's live listings are refreshed, one setting per account (no row: every
-- 72 hours, no quiet window). `custom_hours` only with `custom`. The quiet window is wall-clock
-- minutes in `time_zone` (an IANA name the app reports), `quiet_start` up to `quiet_end`, and
-- may run past midnight (22:00 to 07:00); no refresh starts inside it.
create table listing_refresh_setting (
  account_id uuid primary key references account (id) on delete cascade,
  cadence text not null default 'every_72_hours'
    check (cadence in ('off', 'every_72_hours', 'daily', 'every_few_days', 'weekly', 'custom')),
  custom_hours integer check (custom_hours between 12 and 720),
  quiet_start integer check (quiet_start between 0 and 1439),
  quiet_end integer check (quiet_end between 0 and 1439),
  time_zone text check (char_length(time_zone) between 1 and 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint listing_refresh_setting_custom_hours check ((cadence = 'custom') = (custom_hours is not null)),
  constraint listing_refresh_setting_quiet_whole check ((quiet_start is null) = (quiet_end is null)),
  constraint listing_refresh_setting_quiet_not_empty check (quiet_start <> quiet_end),
  constraint listing_refresh_setting_quiet_has_zone check (quiet_start is null or time_zone is not null)
);

create trigger listing_refresh_setting_set_updated_at
  before update on listing_refresh_setting
  for each row execute function set_updated_at();

-- An item's own refresh cadence, over the account's (null: the account's).
alter table inventory_item
  add column refresh_cadence text
    check (refresh_cadence in ('off', 'every_72_hours', 'daily', 'every_few_days', 'weekly', 'custom')),
  add column refresh_custom_hours integer check (refresh_custom_hours between 12 and 720),
  add constraint inventory_item_refresh_custom_hours
    check ((refresh_cadence is not distinct from 'custom') = (refresh_custom_hours is not null));

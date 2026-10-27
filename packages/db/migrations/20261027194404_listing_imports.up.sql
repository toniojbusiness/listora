-- Importing the seller's existing listings (docs/features/imports.md).
--
-- An import reads the listings for sale on one linked marketplace, a page at a time, read-only,
-- where the connection runs (the seller's iPhone, or the cloud runner), and keeps each listing it
-- read as an entry. The worker then turns each entry into an item that is already listed there,
-- or adds it to the item it is the same as (by its SKU line, else its title and photos), or asks
-- the seller when it is not sure. Nothing on the marketplace is changed.

create table listing_import (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  connection_id uuid not null,
  marketplace marketplace_id not null,
  -- `reading`: pages of listings are still being read. `importing`: reading is over and the
  -- worker is still turning entries into items. `finished`: every entry is settled (some may
  -- wait for the seller).
  status text not null default 'reading' check (status in ('reading', 'importing', 'finished')),
  host text not null check (host in ('runner', 'phone')),
  -- The next page to read (the marketplace's own cursor); null for the first page.
  cursor text check (char_length(cursor) between 1 and 500),
  pages_read integer not null default 0 check (pages_read >= 0),
  -- Listings for sale the pages showed, and how each settled so far.
  listings_read integer not null default 0 check (listings_read >= 0),
  imported integer not null default 0 check (imported >= 0),
  merged integer not null default 0 check (merged >= 0),
  already_listed integer not null default 0 check (already_listed >= 0),
  needs_you integer not null default 0 check (needs_you >= 0),
  failed integer not null default 0 check (failed >= 0),
  -- Why reading stopped before the last page (a check, a page Listora no longer reads); the
  -- listings read before it still import. User-readable, names the marketplace.
  error_code text check (char_length(error_code) between 1 and 100),
  error_message text check (char_length(error_message) between 1 and 500),
  read_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  constraint listing_import_error check ((error_code is null) = (error_message is null)),
  constraint listing_import_read check ((status = 'reading') = (read_at is null)),
  constraint listing_import_finished check ((status = 'finished') = (finished_at is not null)),
  foreign key (account_id, connection_id, marketplace)
    references marketplace_connection (account_id, id, marketplace) on delete cascade
);

-- One import at a time per connection.
create unique index listing_import_one_running on listing_import (account_id, connection_id)
  where status in ('reading', 'importing');
create index listing_import_account_idx on listing_import (account_id, marketplace, created_at);

create trigger listing_import_set_updated_at
  before update on listing_import
  for each row execute function set_updated_at();

create table listing_import_entry (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  import_id uuid not null,
  marketplace marketplace_id not null,
  external_listing_id text not null check (char_length(external_listing_id) between 1 and 200),
  -- The listing as the import read it: its state and details (`ListedListing`).
  listing jsonb not null check (jsonb_typeof(listing) = 'object'),
  -- `pending`: read, not settled yet. `imported`: a new item, listed there. `merged`: added to
  -- the item it is the same as. `already_listed`: Listora already has this listing. `needs_you`:
  -- it may be the same as an item (`candidates`), and the seller decides. `skipped`: the seller
  -- chose not to import it. `failed`: it could not be imported (`error_message`).
  outcome text not null default 'pending'
    check (outcome in ('pending', 'imported', 'merged', 'already_listed', 'needs_you', 'skipped',
      'failed')),
  -- How a merge found its item: its SKU line, its title and photos, or the seller's choice.
  match text check (match in ('sku', 'title_photos', 'seller')),
  item_id uuid,
  listing_id uuid,
  -- For `needs_you`: the items it may be, best first, `[{"itemId": ..., "reason": ...}]`.
  candidates jsonb not null default '[]' check (jsonb_typeof(candidates) = 'array'),
  error_message text check (char_length(error_message) between 1 and 500),
  -- The seller said it is an item of its own (a question answered "a different item"): the
  -- worker imports it as a new item without matching it again.
  new_item boolean not null default false,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  unique (account_id, import_id, external_listing_id),
  constraint listing_import_entry_settled check ((outcome = 'pending') = (settled_at is null)),
  constraint listing_import_entry_failure check ((outcome = 'failed') = (error_message is not null)),
  constraint listing_import_entry_match check ((outcome = 'merged') = (match is not null)),
  foreign key (account_id, import_id) references listing_import (account_id, id) on delete cascade,
  foreign key (account_id, item_id) references inventory_item (account_id, id)
    on delete set null (item_id),
  foreign key (account_id, listing_id) references marketplace_listing (account_id, id)
    on delete set null (listing_id)
);

create index listing_import_entry_outcome_idx on listing_import_entry (account_id, import_id, outcome);

create trigger listing_import_entry_set_updated_at
  before update on listing_import_entry
  for each row execute function set_updated_at();

-- A page of an import waits for the phone like a sale check: one per connection.
alter table phone_work add column import_id uuid;
alter table phone_work add constraint phone_work_import foreign key (account_id, import_id)
  references listing_import (account_id, id) on delete cascade;
alter table phone_work drop constraint phone_work_purpose_check;
alter table phone_work add constraint phone_work_purpose_check
  check (purpose in ('operation', 'session_check', 'sale_check', 'sale_history', 'listing_import'));
alter table phone_work add constraint phone_work_import_target
  check ((import_id is not null) = (purpose = 'listing_import'));
create unique index phone_work_listing_import on phone_work (account_id, connection_id)
  where purpose = 'listing_import';

-- A browser session that read a page of the seller's listings for an import.
alter table automation_run drop constraint automation_run_purpose_check;
alter table automation_run add constraint automation_run_purpose_check
  check (purpose in ('operation', 'sale_check', 'health', 'import'));

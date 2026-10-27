-- Pack check (docs/features/pack-check.md): an optional mode that checks each package before it
-- ships, so a label printed twice or swapped between two packages is caught at the table.

-- The setting, one per account: off until the seller turns it on in Settings.
create table pack_check_setting (
  account_id uuid primary key references account (id) on delete cascade,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger pack_check_setting_set_updated_at
  before update on pack_check_setting
  for each row execute function set_updated_at();

-- A sale's shipping label, one per sale: its tracking number as the marketplace's own order page
-- shows it (`marketplace`), or as the seller scanned it onto the order when Listora had none
-- (`scan`, after the photo check), and the buyer's first name, for the to-ship list. Never the
-- buyer's full name or address. `read_status` is the last read of the order page: `read` (the
-- label was there), `no_label` (the order was, its label not yet), `not_found` (the page didn't
-- show the order), or `failed` (the page couldn't be read, `read_error` says why); a read is not
-- repeated sooner than the read rules allow, however often the list is refreshed.
create table sale_label (
  account_id uuid not null,
  sale_id uuid not null,
  tracking_number text check (tracking_number ~ '^[A-Z0-9]{10,40}$'),
  carrier text check (carrier in ('usps', 'ups', 'fedex', 'dhl', 'other')),
  source text check (source in ('marketplace', 'scan')),
  buyer_first_name text check (char_length(buyer_first_name) between 1 and 40),
  read_status text check (read_status in ('read', 'no_label', 'not_found', 'failed')),
  read_error text check (char_length(read_error) between 1 and 200),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, sale_id),
  foreign key (account_id, sale_id) references sale (account_id, id) on delete cascade,
  constraint sale_label_tracking check (
    (tracking_number is null) = (source is null) and (tracking_number is null) = (carrier is null)
  ),
  constraint sale_label_read check (
    (read_status is null) = (read_at is null) and (read_error is null or read_status = 'failed')
  )
);

create index sale_label_tracking_idx on sale_label (account_id, tracking_number)
  where tracking_number is not null;

create trigger sale_label_set_updated_at
  before update on sale_label
  for each row execute function set_updated_at();

-- A packed order: the label that went on its package and how Listora knew it was the right one
-- (the item's sticker, the label alone, or the seller's photo check of a label Listora didn't
-- know). An order is packed once, and a label is packed once: the duplicate-print guard. The
-- package photo (`photo_key`, a stored JPEG without metadata) is optional proof for a claim.
create table sale_pack (
  account_id uuid not null,
  sale_id uuid not null,
  tracking_number text not null check (tracking_number ~ '^[A-Z0-9]{10,40}$'),
  matched_by text not null check (matched_by in ('sticker', 'label', 'photo')),
  sticker_sku text check (char_length(sticker_sku) between 1 and 32),
  packed_by_user_id uuid references app_user (id) on delete set null,
  packed_at timestamptz not null default now(),
  photo_key text check (char_length(photo_key) between 1 and 512),
  photo_added_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, sale_id),
  unique (account_id, tracking_number),
  foreign key (account_id, sale_id) references sale (account_id, id) on delete cascade,
  constraint sale_pack_sticker check ((sticker_sku is not null) = (matched_by = 'sticker')),
  constraint sale_pack_photo check ((photo_key is null) = (photo_added_at is null))
);

create trigger sale_pack_set_updated_at
  before update on sale_pack
  for each row execute function set_updated_at();

-- A read of the shipping labels of a marketplace's unshipped orders, from the order pages, waits
-- for the phone like a sale check: one per connection.
alter table phone_work drop constraint phone_work_purpose_check;
alter table phone_work add constraint phone_work_purpose_check
  check (purpose in ('operation', 'session_check', 'sale_check', 'sale_history', 'label_read'));
create unique index phone_work_label_read on phone_work (account_id, connection_id)
  where purpose = 'label_read';

alter table automation_run drop constraint automation_run_purpose_check;
alter table automation_run add constraint automation_run_purpose_check
  check (purpose in ('operation', 'sale_check', 'health', 'label_read'));

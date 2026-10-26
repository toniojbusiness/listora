-- Batch listing (docs/features/batch.md): a haul photographed in one session becomes one draft
-- item per physical item. A batch groups those items in capture order, records which of them the
-- app has finished uploading (so the worker starts each one's analysis once its photos are
-- processed), and keeps the seller's measured interaction for the batch and per item.

create table item_batch (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  created_by_user_id uuid references app_user (id) on delete set null,
  -- The seller's interaction as the app measured it (docs/features/review.md#interaction-time):
  -- time on the batch's screens, the part of it spent waiting on Listora, and taps. All three
  -- or none: none until the app reports them.
  active_ms bigint check (active_ms >= 0),
  waiting_ms bigint check (waiting_ms >= 0),
  taps integer check (taps >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  constraint item_batch_interaction_whole
    check ((active_ms is null) = (waiting_ms is null) and (active_ms is null) = (taps is null))
);

create index item_batch_created_idx on item_batch (account_id, created_at);

create table item_batch_item (
  account_id uuid not null references account (id) on delete cascade,
  batch_id uuid not null,
  -- An item is in at most one batch; deleting the item takes it out of its batch.
  item_id uuid not null,
  -- The item's place in the haul, 0 first. Adding an item at a position the batch already has
  -- returns that item, so a batch the app submits again never gets a second item there.
  position integer not null check (position between 0 and 999),
  -- Set when the app has attached every photo, with how many: the worker then starts the
  -- item's analysis once they are processed.
  submitted_at timestamptz,
  photo_count integer check (photo_count between 1 and 24),
  -- Why the worker did not start the analysis (an AI guard refused it, or the photos were not
  -- processed in time). A new submit clears it.
  start_error_code text check (char_length(start_error_code) between 1 and 100),
  start_error_message text check (char_length(start_error_message) between 1 and 1000),
  start_error_retryable boolean,
  -- This item's share of the batch's interaction, as the app measured it.
  active_ms bigint check (active_ms >= 0),
  waiting_ms bigint check (waiting_ms >= 0),
  taps integer check (taps >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, item_id),
  unique (account_id, batch_id, position),
  foreign key (account_id, batch_id) references item_batch (account_id, id) on delete cascade,
  foreign key (account_id, item_id) references inventory_item (account_id, id) on delete cascade,
  constraint item_batch_item_submission_whole check ((submitted_at is null) = (photo_count is null)),
  constraint item_batch_item_start_error_whole check (
    (start_error_code is null) = (start_error_message is null)
    and (start_error_code is null) = (start_error_retryable is null)
  ),
  constraint item_batch_item_start_error_submitted
    check (start_error_code is null or submitted_at is not null),
  constraint item_batch_item_interaction_whole
    check ((active_ms is null) = (waiting_ms is null) and (active_ms is null) = (taps is null))
);

create trigger item_batch_set_updated_at
  before update on item_batch
  for each row execute function set_updated_at();

create trigger item_batch_item_set_updated_at
  before update on item_batch_item
  for each row execute function set_updated_at();

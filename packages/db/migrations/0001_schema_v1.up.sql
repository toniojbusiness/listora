-- Listora schema v1 (plan task T-04). docs/architecture.md section 9 describes the model.
--
-- Conventions used by every table:
-- - `id uuid primary key default uuidv7()` (time-ordered, built into PostgreSQL 18).
-- - Tenant tables carry `account_id` and a `unique (account_id, id)` key. Child rows reference
--   their parent through the composite `(account_id, <parent>_id)`, so a row can never point
--   at another tenant's data, even through a bug in application code.
-- - Deleting an account cascades to all of its data (in-app account deletion).
-- - Money is integer cents (`bigint`, `*_cents`) plus a `currency` column.
-- - `created_at` and `updated_at` default to now(); the `set_updated_at` trigger maintains
--   `updated_at`. Append-only tables have `created_at` only.
-- - Status-like columns are text with a CHECK listing the allowed values. The same lists live
--   in packages/db/src/values.ts, and a test keeps the two in sync.

-- Shared types and trigger functions --------------------------------------------------------

-- ISO 4217 code. Listora launches US-only, so USD is the only accepted currency for now (it
-- matches CurrencyCode in @listora/shared).
create domain currency_code as text
  constraint currency_code_known check (value in ('USD'));

create domain marketplace_id as text
  constraint marketplace_id_known check (value in ('ebay', 'depop', 'poshmark', 'mercari'));

create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Optimistic locking: every update bumps `version`, so a writer that read version N can
-- update with `where version = N` and detect a concurrent change when no row matches.
create function bump_version() returns trigger
language plpgsql as $$
begin
  new.version := old.version + 1;
  return new;
end;
$$;

-- Rejects direct updates and deletes. The only changes allowed are foreign-key actions caused
-- by deleting a parent row, for example the cascade when an account is deleted: those run one
-- trigger level deeper, and the parent row they reference no longer exists. Changes made by
-- any other trigger are rejected too.
create function reject_direct_change() returns trigger
language plpgsql as $$
declare
  parent record;
  parent_deleted boolean;
begin
  if pg_trigger_depth() > 1 then
    for parent in
      select
        fk.confrelid::regclass as parent_table,
        (select string_agg(format('%I', attname), ', ' order by array_position(fk.confkey, attnum))
          from pg_attribute where attrelid = fk.confrelid and attnum = any (fk.confkey)) as parent_columns,
        (select string_agg(format('($1).%I', attname), ', ' order by array_position(fk.conkey, attnum))
          from pg_attribute where attrelid = fk.conrelid and attnum = any (fk.conkey)) as old_values
      from pg_constraint as fk
      where fk.conrelid = tg_relid and fk.contype = 'f' and fk.confdeltype in ('c', 'n')
    loop
      execute format(
        'select row(%1$s) is not null and not exists (select 1 from %2$s where (%3$s) = (%1$s))',
        parent.old_values, parent.parent_table, parent.parent_columns
      ) into parent_deleted using old;
      if parent_deleted then
        return coalesce(new, old);
      end if;
    end loop;
  end if;
  raise exception '%: direct % is not allowed', tg_table_name, lower(tg_op)
    using errcode = 'restrict_violation';
end;
$$;

-- Tenancy -----------------------------------------------------------------------------------

create table account (
  id uuid primary key default uuidv7(),
  name text not null check (char_length(name) between 1 and 200),
  -- SKU prefix (decision D12): 2-4 capital letters, by default the owner's initials.
  sku_prefix text not null check (sku_prefix ~ '^[A-Z]{2,4}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A person who signs in. Identity is global (one person can later be a member of several
-- accounts), so this is the one table without `account_id`; `membership` links it to accounts.
create table app_user (
  id uuid primary key default uuidv7(),
  auth_provider text not null check (auth_provider in ('dev', 'cognito')),
  auth_subject text not null check (char_length(auth_subject) between 1 and 255),
  email text check (email ~ '^[^@\s]+@[^@\s]+$'),
  display_name text check (char_length(display_name) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (auth_provider, auth_subject)
);

create table membership (
  account_id uuid not null references account (id) on delete cascade,
  user_id uuid not null references app_user (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, user_id)
);

create index membership_user_idx on membership (user_id);
-- Exactly one owner per account at most.
create unique index membership_one_owner_idx on membership (account_id) where role = 'owner';

-- Gapless per-account SKU counter. Allocation is `update ... set next_number = next_number + 1
-- returning` inside the item-create transaction: the row lock serializes concurrent creates in
-- one account, and a rolled-back create also rolls back its number. 6 digits (decision D12),
-- so the last SKU is <PREFIX>-999999 and allocating past it fails this CHECK.
create table sku_sequence (
  account_id uuid primary key references account (id) on delete cascade,
  next_number bigint not null default 1 check (next_number between 1 and 1000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Every account gets its SKU counter in the same transaction that creates it.
create function create_sku_sequence() returns trigger
language plpgsql as $$
begin
  insert into sku_sequence (account_id) values (new.id);
  return null;
end;
$$;

create trigger account_create_sku_sequence
  after insert on account
  for each row execute function create_sku_sequence();

-- Inventory ---------------------------------------------------------------------------------

create table storage_location (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  -- Short code printed on the label and in the QR payload, for example `B-12`.
  code text not null check (char_length(code) between 1 and 32),
  label text,
  parent_id uuid constraint storage_location_not_own_parent check (parent_id <> id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  unique (account_id, code),
  foreign key (account_id, parent_id) references storage_location (account_id, id)
    on delete set null (parent_id)
);

create table inventory_item (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  sku text not null check (sku ~ '^[A-Z]{2,4}-[0-9]{6}$'),
  status text not null default 'draft'
    check (status in ('draft', 'ready', 'listed', 'sold_pending_delist', 'sold', 'shipped', 'archived')),
  title text,
  brand text,
  product_name text,
  style_number text,
  rn_number text,
  upc text,
  department text,
  -- Canonical (Listora) category; marketplace categories live on marketplace_listing.
  category text,
  size_label text,
  size_system text,
  colors text[] not null default '{}',
  pattern text,
  materials text[] not null default '{}',
  condition text,
  condition_notes text,
  flaws text[] not null default '{}',
  keywords text[] not null default '{}',
  description text,
  measurements jsonb not null default '{}' check (jsonb_typeof(measurements) = 'object'),
  attributes jsonb not null default '{}' check (jsonb_typeof(attributes) = 'object'),
  currency currency_code not null default 'USD',
  list_price_cents bigint check (list_price_cents >= 0),
  floor_price_cents bigint check (floor_price_cents >= 0),
  cost_cents bigint check (cost_cents >= 0),
  purchase_date date,
  purchase_source text,
  storage_location_id uuid,
  quantity integer not null default 1 check (quantity >= 0),
  accepted_analysis_id uuid,
  -- Where each field's value came from: {"brand": "ocr", "title": "ai", ...}.
  field_provenance jsonb not null default '{}' check (jsonb_typeof(field_provenance) = 'object'),
  -- Optimistic lock; maintained by the bump_version trigger, never written by callers.
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  unique (account_id, sku),
  constraint inventory_item_floor_within_list_price check (floor_price_cents <= list_price_cents),
  foreign key (account_id, storage_location_id) references storage_location (account_id, id)
    on delete set null (storage_location_id)
);

create index inventory_item_status_idx on inventory_item (account_id, status);
create index inventory_item_storage_location_idx on inventory_item (account_id, storage_location_id)
  where storage_location_id is not null;

create table photo (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  item_id uuid not null,
  position integer not null check (position >= 0),
  role text not null check (role in ('front', 'back', 'tag', 'flaw', 'detail')),
  storage_key text not null unique check (char_length(storage_key) between 1 and 1024),
  -- Dimensions and hashes are known once the upload has been processed.
  width integer check (width > 0),
  height integer check (height > 0),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  phash text check (phash ~ '^[0-9a-f]{16}$'),
  derivatives jsonb not null default '{}' check (jsonb_typeof(derivatives) = 'object'),
  ocr_lines jsonb not null default '[]' check (jsonb_typeof(ocr_lines) = 'array'),
  barcodes jsonb not null default '[]' check (jsonb_typeof(barcodes) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  -- Deferred so a transaction can reorder photos by swapping positions.
  unique (item_id, position) deferrable initially deferred,
  foreign key (account_id, item_id) references inventory_item (account_id, id) on delete cascade
);

-- AI ----------------------------------------------------------------------------------------

-- An item's photos are analyzed once per tier: `standard` (default model) and, only on
-- escalation, `premium`. Edits, repricing, and sync never create a new analysis.
create table ai_analysis (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  item_id uuid not null,
  -- sha256 over the ordered photo hashes of the analyzed photo set.
  photo_set_hash text not null check (photo_set_hash ~ '^[0-9a-f]{64}$'),
  tier text not null check (tier in ('standard', 'premium')),
  model text not null check (char_length(model) between 1 and 200),
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed')),
  -- Fields with confidences, marketplace variants, and the labeled price estimate.
  output jsonb check (jsonb_typeof(output) = 'object'),
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  unique (account_id, item_id, id),
  unique (account_id, photo_set_hash, tier),
  constraint ai_analysis_succeeded_has_output check (status <> 'succeeded' or output is not null),
  constraint ai_analysis_failed_has_error check (status <> 'failed' or error_message is not null),
  foreign key (account_id, item_id) references inventory_item (account_id, id) on delete cascade
);

-- The accepted analysis must belong to the same item.
alter table inventory_item
  add foreign key (account_id, id, accepted_analysis_id)
    references ai_analysis (account_id, item_id, id)
    on delete set null (accepted_analysis_id);

-- One row per provider call; the source of truth for AI cost metering.
create table ai_usage_event (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  user_id uuid references app_user (id) on delete set null,
  item_id uuid,
  purpose text not null check (purpose ~ '^[a-z][a-z0-9_]*$'),
  provider text not null check (provider in ('fake', 'anthropic')),
  model text not null check (char_length(model) between 1 and 200),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  images integer not null default 0 check (images >= 0),
  web_searches integer not null default 0 check (web_searches >= 0),
  -- Cost in millionths of a US dollar, computed from the versioned price table.
  cost_micros bigint not null check (cost_micros >= 0),
  price_table_version text not null check (char_length(price_table_version) between 1 and 64),
  latency_ms integer check (latency_ms >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  foreign key (account_id, item_id) references inventory_item (account_id, id)
    on delete set null (item_id)
);

create index ai_usage_event_account_created_idx on ai_usage_event (account_id, created_at);

create table ai_usage_daily (
  account_id uuid not null references account (id) on delete cascade,
  usage_date date not null,
  calls integer not null default 0 check (calls >= 0),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cache_read_tokens bigint not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens bigint not null default 0 check (cache_write_tokens >= 0),
  images bigint not null default 0 check (images >= 0),
  web_searches bigint not null default 0 check (web_searches >= 0),
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, usage_date)
);

-- Marketplaces ------------------------------------------------------------------------------

create table marketplace_connection (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  marketplace marketplace_id not null,
  mode text not null check (mode in ('api', 'assisted')),
  -- The marketplace's immutable user id (eBay userId); null for assisted connections.
  external_user_id text,
  display_name text,
  -- OAuth tokens, encrypted (KMS envelope in production). Assisted connections never hold
  -- credentials: Listora never stores marketplace passwords or sessions.
  token_ciphertext bytea,
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  scopes text[] not null default '{}',
  status text not null default 'connected'
    check (status in ('connected', 'degraded', 'reauth_required', 'revoked')),
  last_ok_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  unique (account_id, id, marketplace),
  unique nulls not distinct (account_id, marketplace, external_user_id),
  constraint marketplace_connection_assisted_holds_no_token
    check (mode <> 'assisted' or token_ciphertext is null)
);

create table marketplace_listing (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  item_id uuid not null,
  marketplace marketplace_id not null,
  connection_id uuid,
  status text not null default 'draft'
    check (status in ('draft', 'queued', 'publishing', 'active', 'ending', 'ended', 'sold', 'error', 'unknown', 'needs_user_action')),
  external_listing_id text,
  external_sku text,
  external_url text,
  -- Per-marketplace variant of the item.
  title text,
  description text,
  currency currency_code not null default 'USD',
  price_cents bigint check (price_cents >= 0),
  category_ref text,
  aspects jsonb not null default '{}' check (jsonb_typeof(aspects) = 'object'),
  listed_at timestamptz,
  ended_at timestamptz,
  last_verified_at timestamptz,
  -- The listing as last read back from the marketplace.
  remote_snapshot jsonb check (jsonb_typeof(remote_snapshot) = 'object'),
  -- Bumped on every local edit; applied_version catches up once the marketplace confirms it.
  desired_version integer not null default 0 check (desired_version >= 0),
  applied_version integer not null default 0 check (applied_version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  unique (account_id, id, item_id, marketplace),
  unique (account_id, marketplace, external_listing_id),
  constraint marketplace_listing_applied_not_ahead check (applied_version <= desired_version),
  foreign key (account_id, item_id) references inventory_item (account_id, id),
  -- The connection must belong to the same account and marketplace.
  foreign key (account_id, connection_id, marketplace)
    references marketplace_connection (account_id, id, marketplace)
);

create index marketplace_listing_item_idx on marketplace_listing (account_id, item_id);
create index marketplace_listing_connection_idx on marketplace_listing (account_id, connection_id)
  where connection_id is not null;
-- At most one live listing per item and marketplace; ended and sold listings stay as history.
create unique index marketplace_listing_one_live_idx on marketplace_listing (account_id, item_id, marketplace)
  where status not in ('ended', 'sold');

-- Sales and delisting -----------------------------------------------------------------------

-- Every inbound signal (webhook, poll result, email, manual entry), deduplicated per account,
-- source, and marketplace, so a provider event id that repeats in another account or on another
-- marketplace is never mistaken for a duplicate and never drops a sale signal.
create table inbound_event (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  source text not null check (source in ('ebay_webhook', 'depop_webhook', 'poll', 'email', 'manual')),
  marketplace marketplace_id not null,
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 255),
  -- Webhook signature or email DKIM result; null where the source has no signature.
  signature_ok boolean,
  payload jsonb not null,
  processed_at timestamptz,
  result text check (result in ('processed', 'ignored', 'failed')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  constraint inbound_event_provider_event_key
    unique (account_id, source, marketplace, provider_event_id),
  constraint inbound_event_signed_source_has_signature
    check (source not in ('ebay_webhook', 'depop_webhook', 'email') or signature_ok is not null),
  constraint inbound_event_processed_has_result check ((processed_at is null) = (result is null)),
  constraint inbound_event_failed_has_error check (result <> 'failed' or error_message is not null)
);

-- One marketplace order. The items it sold are its sale_item rows, since an order can be a
-- bundle of several items.
create table sale (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  marketplace marketplace_id not null,
  -- Null only for manual entries without an order number.
  external_order_id text,
  sold_at timestamptz not null,
  currency currency_code not null default 'USD',
  shipping_charged_cents bigint not null default 0 check (shipping_charged_cents >= 0),
  detection_source text not null check (detection_source in ('webhook', 'poll', 'email', 'manual')),
  inbound_event_id uuid,
  status text not null default 'detected' check (status in ('detected', 'confirmed', 'canceled', 'returned')),
  ship_by timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  unique (account_id, id, marketplace),
  -- A marketplace order is recorded once; a second event for it is a duplicate.
  unique (account_id, marketplace, external_order_id),
  foreign key (account_id, inbound_event_id) references inbound_event (account_id, id)
    on delete set null (inbound_event_id)
);

-- One item sold in an order. Every item of a bundle gets its own row, so each one is marked
-- sold and delisted everywhere else.
create table sale_item (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  sale_id uuid not null,
  -- The sale's marketplace, repeated so the listing can be checked against it.
  marketplace marketplace_id not null,
  item_id uuid not null,
  -- Null for a manual sale recorded without a known listing.
  listing_id uuid,
  currency currency_code not null default 'USD',
  sale_price_cents bigint not null check (sale_price_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  unique (account_id, sale_id, id),
  -- An order sells each item once.
  unique (account_id, sale_id, item_id),
  foreign key (account_id, sale_id, marketplace) references sale (account_id, id, marketplace)
    on delete cascade,
  foreign key (account_id, item_id) references inventory_item (account_id, id),
  -- The listing must be this item's listing on the sale's marketplace.
  foreign key (account_id, listing_id, item_id, marketplace)
    references marketplace_listing (account_id, id, item_id, marketplace)
);

create index sale_item_item_idx on sale_item (account_id, item_id);

-- Aggregates the delist fan-out after one item is sold (a bundle sale starts one run per
-- item); per-listing results are in delist_run_listing.
create table delist_run (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  sale_id uuid not null,
  item_id uuid not null,
  status text not null default 'in_progress'
    check (status in ('in_progress', 'completed', 'attention_needed')),
  -- Re-alert after 10 minutes and escalate after 30 if listings are still unconfirmed.
  realerted_at timestamptz,
  escalated_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  unique (account_id, sale_id, item_id),
  constraint delist_run_completed_has_completed_at
    check ((status = 'completed') = (completed_at is not null)),
  -- The item must be one that the sale sold.
  foreign key (account_id, sale_id, item_id) references sale_item (account_id, sale_id, item_id)
    on delete cascade
);

-- Every marketplace write. The worker drives its state machine (docs/architecture.md section 6).
create table marketplace_operation (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  listing_id uuid not null,
  kind text not null check (kind in ('create', 'revise', 'price', 'end', 'relist', 'mark_sold', 'verify')),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 255),
  -- Snapshot of the desired listing state this operation applies.
  desired jsonb not null check (jsonb_typeof(desired) = 'object'),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'retrying', 'verifying', 'succeeded', 'failed', 'needs_user_action', 'canceled')),
  -- Never false success: `succeeded` requires an API read-back or a user confirmation.
  success_evidence text check (success_evidence in ('read_back', 'user_confirmation')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  error_code text,
  error_message text,
  origin text not null check (origin in ('user', 'auto_delist', 'reprice_rule')),
  delist_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  unique (account_id, idempotency_key),
  constraint marketplace_operation_succeeded_has_evidence
    check (status <> 'succeeded' or success_evidence is not null),
  constraint marketplace_operation_retrying_has_next_attempt
    check (status <> 'retrying' or next_attempt_at is not null),
  -- Failures are always explained to the user.
  constraint marketplace_operation_failed_has_error
    check (status <> 'failed' or error_message is not null),
  constraint marketplace_operation_auto_delist_has_run
    check ((origin = 'auto_delist') = (delist_run_id is not null)),
  foreign key (account_id, listing_id) references marketplace_listing (account_id, id),
  foreign key (account_id, delist_run_id) references delist_run (account_id, id)
);

-- Operation history is kept: an operation is deleted only with its account.
create trigger marketplace_operation_no_direct_delete
  before delete on marketplace_operation
  for each row execute function reject_direct_change();

create index marketplace_operation_listing_idx on marketplace_operation (account_id, listing_id, created_at);
create index marketplace_operation_delist_run_idx on marketplace_operation (account_id, delist_run_id)
  where delist_run_id is not null;

-- Append-only history of every operation state transition.
create table operation_event (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  operation_id uuid not null,
  -- Null for the event that records the operation's creation.
  from_status text
    check (from_status in ('queued', 'running', 'retrying', 'verifying', 'succeeded', 'failed', 'needs_user_action', 'canceled')),
  to_status text not null
    check (to_status in ('queued', 'running', 'retrying', 'verifying', 'succeeded', 'failed', 'needs_user_action', 'canceled')),
  attempt integer not null default 0 check (attempt >= 0),
  error_code text,
  -- Redacted request/response excerpt; never tokens or credentials.
  detail jsonb not null default '{}' check (jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (account_id, operation_id) references marketplace_operation (account_id, id)
    on delete cascade
);

create index operation_event_operation_idx on operation_event (account_id, operation_id, created_at);

create trigger operation_event_append_only
  before update or delete on operation_event
  for each row execute function reject_direct_change();

-- Work only the user can do: assisted listing and delisting, sale confirmation, reconnects.
create table user_task (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  kind text not null
    check (kind in ('list_manually', 'delist_manually', 'confirm_sale', 'reconnect', 'review_match')),
  item_id uuid,
  listing_id uuid,
  -- The assisted operation this task completes; it can finish only through the user's confirmation.
  operation_id uuid,
  delist_run_id uuid,
  urgency text not null default 'normal' check (urgency in ('normal', 'high', 'urgent')),
  deep_link text,
  -- Copy-assist content (title, description, price, photo order) and other task data.
  payload jsonb not null default '{}' check (jsonb_typeof(payload) = 'object'),
  status text not null default 'open' check (status in ('open', 'done', 'dismissed')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  constraint user_task_completed_at_matches_status check ((status = 'open') = (completed_at is null)),
  constraint user_task_manual_listing_task_has_listing
    check (kind not in ('list_manually', 'delist_manually') or listing_id is not null),
  foreign key (account_id, item_id) references inventory_item (account_id, id) on delete cascade,
  foreign key (account_id, listing_id) references marketplace_listing (account_id, id) on delete cascade,
  foreign key (account_id, operation_id) references marketplace_operation (account_id, id) on delete cascade,
  foreign key (account_id, delist_run_id) references delist_run (account_id, id) on delete cascade
);

create index user_task_open_idx on user_task (account_id, urgency, created_at) where status = 'open';
create index user_task_delist_run_idx on user_task (account_id, delist_run_id)
  where delist_run_id is not null;

-- Per-listing results of a delist run: its operations (API marketplaces) and user tasks
-- (assisted marketplaces).
create view delist_run_listing as
  select
    operation.account_id,
    operation.delist_run_id,
    operation.listing_id,
    'operation'::text as source,
    operation.id as source_id,
    operation.status,
    operation.updated_at
  from marketplace_operation as operation
  where operation.delist_run_id is not null
  union all
  select
    task.account_id,
    task.delist_run_id,
    task.listing_id,
    'user_task'::text as source,
    task.id as source_id,
    task.status,
    task.updated_at
  from user_task as task
  where task.delist_run_id is not null;

create table fee_line (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  sale_id uuid not null,
  -- Set for a fee charged on one item of the order; null for an order-level fee.
  sale_item_id uuid,
  kind text not null check (kind in ('marketplace', 'payment', 'shipping_label', 'promotion', 'tax', 'other')),
  currency currency_code not null default 'USD',
  -- Negative for a refunded fee.
  amount_cents bigint not null,
  source text not null check (source in ('actual', 'estimated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  foreign key (account_id, sale_id) references sale (account_id, id) on delete cascade,
  -- The sale item must belong to the same sale.
  foreign key (account_id, sale_id, sale_item_id) references sale_item (account_id, sale_id, id)
    on delete set null (sale_item_id)
);

create index fee_line_sale_idx on fee_line (account_id, sale_id, sale_item_id);

-- Business expenses that are not tied to one item (supplies, mileage, subscriptions).
create table expense (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  incurred_on date not null,
  category text not null check (char_length(category) between 1 and 100),
  description text,
  currency currency_code not null default 'USD',
  amount_cents bigint not null check (amount_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id)
);

-- Pricing -----------------------------------------------------------------------------------

-- Source-labeled pricing data; "sold" and "comps" are shown only next to real sold data.
create table pricing_snapshot (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  item_id uuid not null,
  source text not null check (source in ('depop_inspiration', 'ebay_mi', 'own_history', 'ai_estimate')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  fetched_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  constraint pricing_snapshot_expires_after_fetch check (expires_at > fetched_at),
  foreign key (account_id, item_id) references inventory_item (account_id, id) on delete cascade
);

create index pricing_snapshot_item_idx on pricing_snapshot (account_id, item_id, fetched_at);

-- Billing -----------------------------------------------------------------------------------

create table subscription (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  source text not null check (source in ('stripe', 'app_store')),
  -- Stripe subscription id or App Store original transaction id.
  external_id text not null check (char_length(external_id) between 1 and 255),
  plan text not null check (plan in ('starter', 'seller', 'pro', 'business')),
  status text not null
    check (status in ('trialing', 'active', 'grace_period', 'past_due', 'canceled', 'expired', 'revoked')),
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  unique (source, external_id),
  constraint subscription_period_order check (current_period_end > current_period_start)
);

-- The plan an account is entitled to, unified across Stripe and the App Store.
create table entitlement (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  plan text not null check (plan in ('starter', 'seller', 'pro', 'business')),
  -- Null for a granted entitlement (trial or comp) with no paid subscription behind it.
  subscription_id uuid,
  active_from timestamptz not null,
  active_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  constraint entitlement_period_order check (active_until > active_from),
  foreign key (account_id, subscription_id) references subscription (account_id, id)
    on delete set null (subscription_id)
);

create index entitlement_account_idx on entitlement (account_id, active_from);

-- Quota usage per metric and billing period, in reseller units (for example items analyzed).
create table usage_counter (
  account_id uuid not null references account (id) on delete cascade,
  metric text not null check (metric ~ '^[a-z][a-z0-9_]*$'),
  period_start date not null,
  period_end date not null,
  used integer not null default 0 check (used >= 0),
  -- Null means unlimited.
  quota integer check (quota >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, metric, period_start),
  constraint usage_counter_period_order check (period_end > period_start)
);

-- History -----------------------------------------------------------------------------------

-- Append-only, user-visible history of item changes.
create table audit_log (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  item_id uuid,
  actor_kind text not null check (actor_kind in ('user', 'system', 'ai', 'marketplace')),
  actor_user_id uuid references app_user (id) on delete set null,
  action text not null check (action ~ '^[a-z][a-z0-9_.]*$'),
  changes jsonb not null default '{}' check (jsonb_typeof(changes) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (account_id, item_id) references inventory_item (account_id, id) on delete cascade
);

create index audit_log_item_idx on audit_log (account_id, item_id, created_at);

create trigger audit_log_append_only
  before update or delete on audit_log
  for each row execute function reject_direct_change();

-- Triggers that maintain updated_at and version ---------------------------------------------

create trigger inventory_item_bump_version
  before update on inventory_item
  for each row execute function bump_version();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'account', 'app_user', 'membership', 'sku_sequence', 'storage_location', 'inventory_item',
    'photo', 'ai_analysis', 'ai_usage_event', 'ai_usage_daily', 'marketplace_connection',
    'marketplace_listing', 'inbound_event', 'sale', 'sale_item', 'delist_run', 'marketplace_operation',
    'user_task', 'fee_line', 'expense', 'pricing_snapshot', 'subscription', 'entitlement',
    'usage_counter'
  ] loop
    execute format(
      'create trigger %I before update on %I for each row execute function set_updated_at()',
      table_name || '_set_updated_at',
      table_name
    );
  end loop;
end;
$$;

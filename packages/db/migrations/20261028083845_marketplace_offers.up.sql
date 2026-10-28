-- Offers (docs/features/offers.md): the offers buyers made on the seller's listings, read
-- read-only through the seller's own session where the connection runs, each shown in Tasks;
-- the seller's answer to one (accept, decline, or counter), sent only on their tap and done
-- only once a read-back of the offer shows it; and when each connection's offers were read.

-- An offer as the marketplace last showed it. `pending` waits on the seller; `accepted`,
-- `declined`, and `countered` are what the seller's confirmed answer made it; `closed` is an
-- offer the marketplace no longer shows as waiting on the seller (it expired, the buyer
-- withdrew it or bought the listing, or the seller answered it in the marketplace's app).
create table marketplace_offer (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  connection_id uuid not null,
  marketplace marketplace_id not null,
  external_offer_id text not null check (length(external_offer_id) between 1 and 255),
  -- The marketplace listing it is for, and Listora's listing and item when it has that listing.
  external_listing_id text check (length(external_listing_id) between 1 and 255),
  listing_id uuid,
  item_id uuid,
  listing_title text check (length(listing_title) <= 200),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'countered', 'closed')),
  currency currency_code not null default 'USD',
  amount_cents bigint not null check (amount_cents > 0),
  list_price_cents bigint check (list_price_cents > 0),
  -- The buyer's public username on the marketplace, as the offer shows it; nothing more of them.
  buyer_name text check (length(buyer_name) <= 100),
  -- What else the offer says (shipping, how many listings, whose turn it is), by name.
  details jsonb not null default '{}' check (jsonb_typeof(details) = 'object'),
  -- Where the seller answers it on the marketplace (Open in Poshmark).
  offer_url text check (length(offer_url) <= 2000),
  made_at timestamptz,
  expires_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  unique (account_id, connection_id, external_offer_id),
  foreign key (account_id, connection_id, marketplace)
    references marketplace_connection (account_id, id, marketplace) on delete cascade,
  foreign key (account_id, listing_id)
    references marketplace_listing (account_id, id) on delete set null (listing_id),
  foreign key (account_id, item_id)
    references inventory_item (account_id, id) on delete set null (item_id),
  constraint marketplace_offer_closed check ((status = 'pending') = (closed_at is null))
);

create index marketplace_offer_pending on marketplace_offer (account_id, connection_id)
  where status = 'pending';

create trigger marketplace_offer_set_updated_at
  before update on marketplace_offer
  for each row execute function set_updated_at();

-- The seller's answer to an offer, one per tap (its Idempotency-Key). It is sent once, by the
-- phone, and is `succeeded` only with a read-back of the offer that shows it; a send that may
-- have reached the marketplace is never sent again, only read back.
create table offer_response (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  offer_id uuid not null,
  action text not null check (action in ('accept', 'decline', 'counter')),
  -- The offer's amount the seller saw when they confirmed, and for a counter their price.
  currency currency_code not null default 'USD',
  offer_amount_cents bigint not null check (offer_amount_cents > 0),
  counter_cents bigint check (counter_cents > 0),
  -- What the confirmation showed the seller would get after the marketplace's fees.
  net_cents bigint not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 255),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'verifying', 'succeeded', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  -- A send that may have reached the marketplace: from then on it is only read back.
  sent boolean not null default false,
  success_evidence text check (success_evidence = 'read_back'),
  error_code text check (length(error_code) <= 100),
  error_message text check (length(error_message) <= 500),
  retryable boolean not null default false,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  unique (account_id, offer_id, idempotency_key),
  foreign key (account_id, offer_id) references marketplace_offer (account_id, id) on delete cascade,
  constraint offer_response_counter check ((counter_cents is not null) = (action = 'counter')),
  constraint offer_response_succeeded
    check ((status = 'succeeded') = (success_evidence is not null)),
  constraint offer_response_failed check (status <> 'failed' or error_message is not null),
  constraint offer_response_finished
    check ((status in ('succeeded', 'failed')) = (finished_at is not null))
);

-- One answer at a time per offer.
create unique index offer_response_open on offer_response (account_id, offer_id)
  where status in ('queued', 'running', 'verifying');

create trigger offer_response_set_updated_at
  before update on offer_response
  for each row execute function set_updated_at();

-- When each automation connection's offers were last asked for and read, and how that went.
create table offer_check (
  account_id uuid not null references account (id) on delete cascade,
  connection_id uuid not null,
  marketplace marketplace_id not null,
  requested_at timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_succeeded_at timestamptz,
  last_outcome text check (last_outcome in ('succeeded', 'failed')),
  last_error_code text check (length(last_error_code) <= 100),
  last_error_message text check (length(last_error_message) <= 500),
  offers_seen integer check (offers_seen >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, connection_id),
  foreign key (account_id, connection_id, marketplace)
    references marketplace_connection (account_id, id, marketplace) on delete cascade
);

create trigger offer_check_set_updated_at
  before update on offer_check
  for each row execute function set_updated_at();

-- Each pending offer is a task in the seller's inbox, one open task per offer.
alter table user_task add column offer_id uuid;
alter table user_task add constraint user_task_offer foreign key (account_id, offer_id)
  references marketplace_offer (account_id, id) on delete cascade;
alter table user_task drop constraint user_task_kind_check;
alter table user_task add constraint user_task_kind_check
  check (
    kind in (
      'list_manually', 'delist_manually', 'edit_manually', 'confirm_sale', 'reconnect',
      'review_match', 'resolve_double_sale', 'answer_offer'
    )
  );
alter table user_task add constraint user_task_offer_target
  check ((offer_id is not null) = (kind = 'answer_offer'));
create unique index user_task_open_offer on user_task (account_id, offer_id)
  where status = 'open' and offer_id is not null;

-- Reading a connection's offers, and sending an answer to one, wait for the phone like a sale
-- check: one offer read per connection, one run per answer.
alter table phone_work add column offer_response_id uuid;
alter table phone_work add constraint phone_work_offer_response
  foreign key (account_id, offer_response_id)
  references offer_response (account_id, id) on delete cascade;
alter table phone_work drop constraint phone_work_purpose_check;
alter table phone_work add constraint phone_work_purpose_check
  check (
    purpose in (
      'operation', 'session_check', 'sale_check', 'sale_history', 'listing_import', 'label_read',
      'offer_check', 'offer_response'
    )
  );
alter table phone_work add constraint phone_work_offer_response_target
  check ((offer_response_id is not null) = (purpose = 'offer_response'));
create unique index phone_work_offer_check on phone_work (account_id, connection_id)
  where purpose = 'offer_check';
create unique index phone_work_offer_response_idx on phone_work (account_id, offer_response_id)
  where offer_response_id is not null;

alter table automation_run drop constraint automation_run_purpose_check;
alter table automation_run add constraint automation_run_purpose_check
  check (
    purpose in ('operation', 'sale_check', 'health', 'import', 'label_read', 'offer_check', 'offer_response')
  );

-- An accepted offer asks for a sale check at once, so its sale goes through the normal sale flow.
alter table sale_check_schedule drop constraint sale_check_schedule_next_reason_check;
alter table sale_check_schedule add constraint sale_check_schedule_next_reason_check
  check (next_reason in ('scheduled', 'email', 'retry', 'linked', 'offer'));
alter table sale_check_run drop constraint sale_check_run_reason_check;
alter table sale_check_run add constraint sale_check_run_reason_check
  check (reason in ('scheduled', 'email', 'retry', 'linked', 'offer'));

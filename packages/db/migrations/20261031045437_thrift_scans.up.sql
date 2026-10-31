-- The thrift scan (docs/features/thrift-scan.md): a sourcing run is one trip to a store, and
-- each item the seller scans there is an item scan with the AI's read and the call. A scan the
-- seller keeps becomes an inventory item; the rest are kept only as long as the retention job
-- allows (`skippedScans`), while the run keeps their counts.
create table sourcing_run (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  created_by_user_id uuid references app_user (id) on delete set null,
  -- Where the seller is, as they named it; none until they do.
  place text check (char_length(place) between 1 and 200),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  -- Every scan of the run and those kept, kept after skipped scans are deleted.
  scan_count integer not null default 0 check (scan_count >= 0),
  kept_count integer not null default 0 check (kept_count between 0 and scan_count),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id)
);

create index sourcing_run_started_idx on sourcing_run (account_id, started_at);

create trigger sourcing_run_set_updated_at
  before update on sourcing_run
  for each row execute function set_updated_at();

-- One item scanned at the store. The images are never stored: the server checks them, sends
-- them to the AI, and keeps only their hash. Nothing here names another seller or listing.
create table item_scan (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  run_id uuid not null,
  created_by_user_id uuid references app_user (id) on delete set null,
  -- SHA-256 of the item shot, and how many images the scan had (the shot and a tag close-up).
  image_sha256 text not null check (image_sha256 ~ '^[0-9a-f]{64}$'),
  image_count integer not null check (image_count between 1 and 2),
  -- The AI's read (`ThriftScan` of @listora/analysis): identity, AI estimate, flags.
  read jsonb not null,
  -- The call and what it rested on, as the app showed it.
  call text not null check (call in ('buy', 'your_call', 'skip')),
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  basis text not null check (basis in ('own_history', 'web_info', 'ai_estimate', 'none')),
  call_detail jsonb not null,
  -- What the seller did: `undecided` until they keep it, a later scan of the same item replaces
  -- it, or the run ends (`skipped`).
  decision text not null default 'undecided'
    check (decision in ('undecided', 'kept', 'skipped', 'replaced')),
  item_id uuid,
  -- The model that read it, what its calls cost, and the time from receipt to answer.
  model text not null,
  ai_attempts integer not null check (ai_attempts between 1 and 10),
  cost_micros bigint not null check (cost_micros >= 0),
  read_ms integer not null check (read_ms >= 0),
  -- The web-grounded research that came in after the read (`scan_research.research`), and how
  -- long it took (0 from the cache); none until the app asks for it.
  research jsonb,
  research_ms integer check (research_ms >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  foreign key (account_id, run_id) references sourcing_run (account_id, id) on delete cascade,
  foreign key (account_id, item_id) references inventory_item (account_id, id)
    on delete set null (item_id),
  constraint item_scan_kept_item check (decision = 'kept' or item_id is null)
);

create index item_scan_run_idx on item_scan (account_id, run_id, created_at);
-- The daily scan limit counts an account's scans of the last day.
create index item_scan_created_idx on item_scan (account_id, created_at);
-- The retention job deletes scans that were never kept, oldest first.
create index item_scan_unkept_idx on item_scan (created_at) where decision <> 'kept';
create unique index item_scan_item_idx on item_scan (account_id, item_id) where item_id is not null;

create trigger item_scan_set_updated_at
  before update on item_scan
  for each row execute function set_updated_at();

-- What the web said (docs/features/thrift-scan.md, "Web info"), kept so a repeat scan of the
-- same thing is instant and costs no search. Two kinds: an item's facts (its retail price and
-- what such items resell for), keyed by the brand, the item type, and its identifying details
-- (line or model, material, style, the item's words), since one brand makes many different
-- items; and a brand's facts (how well it resells), keyed by the brand alone and kept shorter.
-- Per account, like everything else.
create table scan_research (
  account_id uuid not null references account (id) on delete cascade,
  kind text not null check (kind in ('item', 'brand')),
  -- `itemResearchKey` or `brandResearchKey` in @listora/sourcing.
  key text not null check (char_length(key) between 1 and 400),
  research jsonb not null,
  model text not null,
  cost_micros bigint not null check (cost_micros >= 0),
  created_at timestamptz not null default now(),
  primary key (account_id, kind, key)
);

create index scan_research_created_idx on scan_research (created_at);

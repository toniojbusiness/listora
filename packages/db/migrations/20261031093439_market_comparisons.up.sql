-- The thrift scan's marketplace comparisons (docs/features/thrift-scan.md, "Marketplace
-- comparisons"): each read of a marketplace's public search the server handed the seller's
-- iPhone, and what it answered. Only numbers: the counts and quartiles of listings like the
-- item, never a listing, a seller, or a photo. The rows are the reads' budget (per account and
-- marketplace, per hour and day), their 24-hour cache (by `query_key`), and the pause after a
-- check.
create table market_comparison (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  -- The scan it was read for; a later scan that found it in the cache does not name it.
  scan_id uuid,
  marketplace text not null check (marketplace in ('ebay', 'depop', 'poshmark', 'mercari')),
  -- SHA-256 of the normalized search, and the search itself (the brand, type, model, size).
  query_key text not null check (query_key ~ '^[0-9a-f]{64}$'),
  query jsonb not null,
  -- `pending` until the phone answers: `read` (with `stats`), `check` (a bot check or CAPTCHA,
  -- which Listora never passes), `rate_limited`, or `failed`.
  status text not null default 'pending'
    check (status in ('pending', 'read', 'check', 'rate_limited', 'failed')),
  stats jsonb,
  for_sale_total integer check (for_sale_total >= 0),
  read_ms integer check (read_ms >= 0),
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  foreign key (account_id, scan_id) references item_scan (account_id, id)
    on delete set null (scan_id),
  constraint market_comparison_read_stats check ((status = 'read') = (stats is not null))
);

-- The budget and the pause look at an account's reads of a marketplace, newest first.
create index market_comparison_recent_idx
  on market_comparison (account_id, marketplace, created_at desc);
-- The cache finds a read of the same search.
create index market_comparison_cache_idx
  on market_comparison (account_id, marketplace, query_key, created_at desc)
  where status = 'read';
-- The retention job deletes old reads, oldest first.
create index market_comparison_created_idx on market_comparison (created_at);

create trigger market_comparison_set_updated_at
  before update on market_comparison
  for each row execute function set_updated_at();

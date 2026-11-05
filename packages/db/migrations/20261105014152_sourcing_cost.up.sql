-- Where the household sources (docs/features/thrift-scan.md, "What it costs"): the scan's call
-- weighs each item's likely cost there. One row per account; no row means Listora's default,
-- the bins at $1.99 a pound. At the bins an item costs its typical weight times the price per
-- pound; at a store, `store_item_cents` when set, else the typical price for its category.
create table sourcing_cost (
  account_id uuid primary key references account (id) on delete cascade,
  mode text not null check (mode in ('bins', 'store')),
  bins_price_per_pound_cents integer not null
    check (bins_price_per_pound_cents between 10 and 2000),
  store_item_cents integer check (store_item_cents between 0 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger sourcing_cost_set_updated_at
  before update on sourcing_cost
  for each row execute function set_updated_at();

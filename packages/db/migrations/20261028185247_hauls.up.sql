-- Hauls (docs/features/hauls.md): items bought together for one price, such as 30 items from the
-- bins for $50. The seller enters the total and how many items the haul had, and each item in it
-- costs its share: the total split over the count, the leftover cents on the items that joined
-- first, so a full haul's items add back up to the total. The API keeps every member's
-- `cost_cents` equal to its share, so profit, sales, and pricing read the item's cost as before.
create table haul (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  total_cents bigint not null check (total_cents >= 0),
  currency currency_code not null default 'USD',
  -- How many items the haul had; never fewer than the items in it (the API grows it when more
  -- join).
  item_count integer not null check (item_count between 1 and 10000),
  -- When and where it was bought; each item in the haul takes them.
  purchase_date date,
  purchase_source text check (char_length(purchase_source) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id)
);

create index haul_created_idx on haul (account_id, created_at);

create trigger haul_set_updated_at
  before update on haul
  for each row execute function set_updated_at();

-- The haul an item is part of, and when it joined (its place for the leftover cents).
alter table inventory_item
  add column haul_id uuid,
  add column haul_joined_at timestamptz,
  add constraint inventory_item_account_id_haul_id_fkey
    foreign key (account_id, haul_id) references haul (account_id, id),
  add constraint inventory_item_haul_whole check ((haul_id is null) = (haul_joined_at is null));

create index inventory_item_haul_idx on inventory_item (account_id, haul_id, haul_joined_at, id)
  where haul_id is not null;

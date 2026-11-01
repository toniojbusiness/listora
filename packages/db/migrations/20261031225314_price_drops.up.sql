-- Smart price drops (docs/features/price-drops.md): the seller's rules for lowering the price of
-- a live listing that hasn't sold ("10% off after 21 days, never below $30"), for one item or
-- every item of a brand. The worker's schedule runs each drop as an ordinary price change on the
-- operation engine (origin `reprice_rule`), so it is confirmed only by a read-back and a
-- failure shows with Retry.
create table price_drop_rule (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  scope text not null check (scope in ('item', 'brand')),
  -- The item a rule of its own is for.
  item_id uuid,
  -- The brand as the seller wrote it, and the key items' brands are matched by (`brandKey`).
  brand text check (char_length(brand) between 1 and 200),
  brand_key text check (char_length(brand_key) between 1 and 200),
  -- Each drop takes this share off the price, after the listing went this many days unsold
  -- (since it went live or its price last changed), and never below the floor.
  percent integer not null check (percent between 1 and 50),
  after_days integer not null check (after_days between 1 and 365),
  floor_cents bigint not null check (floor_cents > 0),
  currency currency_code not null default 'USD',
  enabled boolean not null default true,
  -- When the rule last took effect (made, changed, or turned on): no drop runs until a day
  -- after it, so the seller always sees a planned drop before it runs.
  armed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  foreign key (account_id, item_id) references inventory_item (account_id, id) on delete cascade,
  constraint price_drop_rule_item check ((scope = 'item') = (item_id is not null)),
  constraint price_drop_rule_brand
    check ((scope = 'brand') = (brand is not null) and (brand is null) = (brand_key is null))
);

-- One rule per item and one per brand.
create unique index price_drop_rule_item_idx on price_drop_rule (account_id, item_id)
  where scope = 'item';
create unique index price_drop_rule_brand_idx on price_drop_rule (account_id, brand_key)
  where scope = 'brand';

create trigger price_drop_rule_set_updated_at
  before update on price_drop_rule
  for each row execute function set_updated_at();

-- The rule a price drop ran under; it stays with the operation's history when the rule is
-- deleted (then null).
alter table marketplace_operation
  add column price_drop_rule_id uuid,
  add constraint marketplace_operation_price_drop_rule
    foreign key (account_id, price_drop_rule_id) references price_drop_rule (account_id, id)
    on delete set null (price_drop_rule_id),
  add constraint marketplace_operation_price_drop_rule_origin
    check (price_drop_rule_id is null or (origin = 'reprice_rule' and kind = 'price'));

-- The schedule's pace counts a connection's drops of the last day.
create index marketplace_operation_price_drop_idx on marketplace_operation (account_id, created_at)
  where origin = 'reprice_rule';

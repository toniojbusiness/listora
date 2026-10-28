-- A connection knows which shop it holds (docs/features/marketplace-linking.md#the-shop-a-connection-holds).
--
-- An automation connection's session check now records the seller its session is signed in as
-- in `marketplace_connection.external_user_id`, as an API connection already records its
-- seller's id. Read only and protected shops follow that seller, not only the row:
--
-- - `read_only_seller` remembers each seller an account's read-only connection held, so a later
--   check that finds one of them on any connection of the account makes it read only again,
--   until the owner turns Read only off with that seller linked.
-- - `protected_seller` names shops Listora only ever reads, whoever links them: a connection
--   that holds one is read only and stays read only. Only a migration changes this table.

create table read_only_seller (
  account_id uuid not null references account (id) on delete cascade,
  marketplace marketplace_id not null,
  seller_id text not null check (char_length(seller_id) between 1 and 255),
  created_at timestamptz not null default now(),
  primary key (account_id, marketplace, seller_id)
);

-- A shop is named by its seller id; one not yet known by the connection that holds it, whose
-- first recorded seller then fills the id in (and the row names the shop from then on).
create table protected_seller (
  id uuid primary key default uuidv7(),
  marketplace marketplace_id not null,
  seller_id text check (char_length(seller_id) between 1 and 255),
  connection_id uuid,
  -- Why the shop is protected, for whoever reads the table; never the shop's data.
  reason text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default now(),
  check (seller_id is not null or connection_id is not null),
  unique (marketplace, seller_id)
);

-- A connection that holds a protected shop is read only, whatever sets it; one that comes to
-- hold a seller the account kept read only becomes read only again.
create function protect_connection_seller() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1 from protected_seller as shop
    where shop.marketplace = new.marketplace
      and (
        shop.seller_id = new.external_user_id
        or (shop.seller_id is null and shop.connection_id = new.id)
      )
  ) then
    new.read_only := true;
  elsif new.external_user_id is not null
    and (tg_op = 'INSERT' or new.external_user_id is distinct from old.external_user_id)
    and exists (
      select 1 from read_only_seller as seller
      where seller.account_id = new.account_id
        and seller.marketplace = new.marketplace
        and seller.seller_id = new.external_user_id
    ) then
    new.read_only := true;
  end if;
  return new;
end;
$$;

create trigger marketplace_connection_protect_seller
  before insert or update of read_only, external_user_id on marketplace_connection
  for each row execute function protect_connection_seller();

-- The account keeps the seller of a read-only connection (and the marketplace's setting, which a
-- read only set by the trigger above would not otherwise reach), forgets it only when the owner
-- turns Read only off with that seller linked, and a protected shop known only by its connection
-- learns its seller id.
create function keep_read_only_seller() returns trigger
language plpgsql as $$
begin
  if new.read_only then
    insert into marketplace_read_only (account_id, marketplace)
    values (new.account_id, new.marketplace)
    on conflict do nothing;
    if new.external_user_id is not null then
      insert into read_only_seller (account_id, marketplace, seller_id)
      values (new.account_id, new.marketplace, new.external_user_id)
      on conflict do nothing;
    end if;
  elsif tg_op = 'UPDATE' and old.read_only and new.external_user_id is not null then
    delete from read_only_seller
    where account_id = new.account_id
      and marketplace = new.marketplace
      and seller_id = new.external_user_id;
  end if;
  if new.external_user_id is not null then
    update protected_seller as shop
    set seller_id = new.external_user_id
    where shop.marketplace = new.marketplace
      and shop.seller_id is null
      and shop.connection_id = new.id
      and not exists (
        select 1 from protected_seller as known
        where known.marketplace = new.marketplace and known.seller_id = new.external_user_id
      );
  end if;
  return null;
end;
$$;

create trigger marketplace_connection_keep_read_only_seller
  after insert or update of read_only, external_user_id on marketplace_connection
  for each row execute function keep_read_only_seller();

-- The sellers of the connections read only today.
insert into read_only_seller (account_id, marketplace, seller_id)
select account_id, marketplace, external_user_id
from marketplace_connection
where read_only and external_user_id is not null
on conflict do nothing;

-- The live Depop shop of migration 20261028061657 (the personal deployment): protected by the
-- connection that holds it until its next session check records its seller, then by that seller.
-- The connection id is already public there and names nothing in any other database.
insert into protected_seller (marketplace, connection_id, reason)
values (
  'depop',
  '01a1810e-62e9-723f-8a5a-19e2f44ce59e',
  'A real seller''s live shop with real buyers, linked on 2026-10-28: Listora only ever reads it.'
);

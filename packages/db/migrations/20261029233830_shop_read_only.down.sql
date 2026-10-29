-- Connections keep their read-only setting (`read_only`), and protected shops stay protected by
-- their digest, so nothing becomes writable here. The listings stay off the test shop's
-- connection. The triggers go back to the rules of 20261029042234_shop_seller, without its
-- protection by connection, and its columns come back empty for the code before this one.
create or replace function keep_read_only_seller() returns trigger
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
  return null;
end;
$$;

create or replace function protect_connection_seller() returns trigger
language plpgsql as $$
begin
  if new.external_user_id is not null and exists (
    select 1 from protected_seller as shop
    where shop.marketplace = new.marketplace
      and shop.seller_digest = encode(sha256(convert_to(new.external_user_id, 'UTF8')), 'hex')
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

create or replace function inherit_marketplace_read_only() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1 from marketplace_read_only
    where account_id = new.account_id and marketplace = new.marketplace
  ) then
    new.read_only := true;
  end if;
  return new;
end;
$$;

alter table marketplace_connection drop column read_only_carried;
alter table protected_seller add column seller_id text, add column connection_id uuid;
drop function seller_digest(text);

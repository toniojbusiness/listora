-- Read only follows the shop, not the account's marketplace (docs/features/read-only.md#the-shop-not-the-row).
--
-- Migration 20261029042234_shop_seller protected the live Depop shop by the connection that held
-- it, to learn the shop's seller from that connection's first recorded seller. On 2026-10-29 the
-- owner linked their own test shop on the account's Depop, which replaces the session on the
-- same connection, before any session check had recorded the live shop's seller. The test shop's
-- check was then the first, so the protection (and the account's read-only sellers) learned the
-- test shop: its Read only could not be turned off, and the live shop was no longer protected by
-- its seller. Now:
--
-- 1. A protected shop is named by its seller only, never learned from a connection. The seller
--    is kept as a SHA-256 digest (`seller_digest`), so a real shop's handle never has to be in
--    the repository.
-- 2. A connection that started read only only because the account's marketplace was
--    (`read_only_carried`) stays read only until its session check names the shop, then follows
--    the shop: read only for a protected shop or a seller the account kept read only, writable
--    for any other. A connection that comes to hold another known seller follows the new seller
--    the same way. The owner's own setting on a connection is the seller's from then on.
-- 3. One-off, in the personal deployment: the live shop protected by its seller's digest, and
--    the live shop's listings off the connection that now holds the test shop.

-- The digest a protected shop is named by: SHA-256 of the seller id, in hex.
create function seller_digest(seller_id text) returns text
language sql immutable strict parallel safe
return encode(sha256(convert_to(seller_id, 'UTF8')), 'hex');

-- 1. Protected shops by seller digest. A shop named by its connection (the live shop's, which
-- learned the test shop) goes; one named by its seller keeps its seller as a digest.
delete from protected_seller where connection_id is not null;
alter table protected_seller add column seller_digest text;
update protected_seller set seller_digest = seller_digest(seller_id);
alter table protected_seller
  drop column seller_id,
  drop column connection_id,
  alter column seller_digest set not null,
  add check (seller_digest ~ '^[0-9a-f]{64}$'),
  add unique (marketplace, seller_digest);

-- 2. Read only carried from the account's marketplace, until the shop is named.
alter table marketplace_connection
  add column read_only_carried boolean not null default false,
  add check (read_only or not read_only_carried);

-- A new connection of a read-only marketplace starts read only, carried.
create or replace function inherit_marketplace_read_only() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1 from marketplace_read_only
    where account_id = new.account_id and marketplace = new.marketplace
  ) then
    new.read_only := true;
    new.read_only_carried := true;
  end if;
  return new;
end;
$$;

-- A connection that holds a protected shop is read only, whatever sets it. One that names its
-- shop (its first seller, or another one) follows that shop: read only for a seller the account
-- kept read only, writable when its read only was carried or belonged to the shop it held before.
create or replace function protect_connection_seller() returns trigger
language plpgsql as $$
begin
  if new.external_user_id is not null and exists (
    select 1 from protected_seller as shop
    where shop.marketplace = new.marketplace
      and shop.seller_digest = seller_digest(new.external_user_id)
  ) then
    new.read_only := true;
    new.read_only_carried := false;
  elsif new.external_user_id is not null
    and (tg_op = 'INSERT' or new.external_user_id is distinct from old.external_user_id) then
    if exists (
      select 1 from read_only_seller as seller
      where seller.account_id = new.account_id
        and seller.marketplace = new.marketplace
        and seller.seller_id = new.external_user_id
    ) then
      new.read_only := true;
    elsif new.read_only_carried
      or (tg_op = 'UPDATE' and old.external_user_id is not null) then
      new.read_only := false;
    end if;
    new.read_only_carried := false;
  end if;
  if not new.read_only then
    new.read_only_carried := false;
  end if;
  return new;
end;
$$;

-- The account keeps the seller of a connection read only by its own setting (not a carried one),
-- and the marketplace's setting, and forgets the seller only when the owner turns Read only off
-- with that seller linked. Nothing here names a protected shop.
create or replace function keep_read_only_seller() returns trigger
language plpgsql as $$
begin
  if new.read_only then
    insert into marketplace_read_only (account_id, marketplace)
    values (new.account_id, new.marketplace)
    on conflict do nothing;
    if new.external_user_id is not null and not new.read_only_carried then
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

-- 3. The live Depop shop of migration 20261028061657, protected by its seller on any connection
-- of any account. Only the digest is here, never the handle.
insert into protected_seller (marketplace, seller_digest, reason)
values (
  'depop',
  'aad3b2ee04d134389b11cda5acb004bc341b2fa44bae5ad650d74d93426ee1f5',
  'A real seller''s live shop with real buyers, linked on 2026-10-28: Listora only ever reads it.'
);

-- Its listings are on the connection that held it, which now holds the owner's test shop. They
-- leave it as on an unlink, marked as from the previous shop, so no session of the test shop
-- runs for them and an import of the live shop takes them back. Named by the connection, its
-- account, and its marketplace, and only while the connection holds another seller than the
-- live shop, so it changes nothing in any other database. The connection keeps its setting: the
-- owner turns its Read only off in the app.
update marketplace_listing
set connection_id = null, remote_snapshot = null, shop_unlinked_at = now()
where account_id = '01a1755b-25e4-780b-8bff-07839b296f3e'
  and marketplace = 'depop'
  and connection_id = '01a1810e-62e9-723f-8a5a-19e2f44ce59e'
  and exists (
    select 1 from marketplace_connection as connection
    where connection.id = '01a1810e-62e9-723f-8a5a-19e2f44ce59e'
      and connection.account_id = '01a1755b-25e4-780b-8bff-07839b296f3e'
      and connection.external_user_id is not null
      and seller_digest(connection.external_user_id)
        <> 'aad3b2ee04d134389b11cda5acb004bc341b2fa44bae5ad650d74d93426ee1f5'
  );

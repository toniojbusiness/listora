-- Read only survives an unlink (docs/features/read-only.md#unlinking-and-relinking).
--
-- The setting was the connection row's (`marketplace_connection.read_only`, default false), and
-- unlinking deletes the row, so a relink of the same shop created a writable connection. Now the
-- account keeps the setting per marketplace in `marketplace_read_only`: a row while the account's
-- connection on that marketplace is read only, kept when the connection is deleted (an unlink, the
-- retention job, an operator's purge), and removed only when the setting is turned off. Every new
-- connection of that marketplace on the account starts read only. The API also refuses to unlink
-- a read-only connection until the owner turns Read only off.
create table marketplace_read_only (
  account_id uuid not null references account (id) on delete cascade,
  marketplace marketplace_id not null,
  created_at timestamptz not null default now(),
  primary key (account_id, marketplace)
);

-- A new connection starts read only when its marketplace is read only on the account.
create function inherit_marketplace_read_only() returns trigger
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

create trigger marketplace_connection_inherit_read_only
  before insert on marketplace_connection
  for each row execute function inherit_marketplace_read_only();

-- The account's setting follows the connection's: set with it, removed only when it is turned
-- off (never when the connection is deleted).
create function keep_marketplace_read_only() returns trigger
language plpgsql as $$
begin
  if new.read_only then
    insert into marketplace_read_only (account_id, marketplace)
    values (new.account_id, new.marketplace)
    on conflict do nothing;
  elsif tg_op = 'UPDATE' and old.read_only then
    delete from marketplace_read_only
    where account_id = new.account_id and marketplace = new.marketplace;
  end if;
  return null;
end;
$$;

create trigger marketplace_connection_keep_read_only
  after insert or update of read_only on marketplace_connection
  for each row execute function keep_marketplace_read_only();

-- The connections read only today (the live Depop shop's, in the personal deployment).
insert into marketplace_read_only (account_id, marketplace)
select account_id, marketplace from marketplace_connection where read_only
on conflict do nothing;

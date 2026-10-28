-- An item's change wakes the item screen waiting for it (docs/features/operations.md, "Following
-- a change"): every new or updated operation notifies `item_change` with its listing's item id,
-- and the API answers the app's wait (`waitForItemChange`) at once instead of the app reading
-- the item every second. Postgres delivers each notification when its transaction commits.
create function item_change_notify() returns trigger
language plpgsql as $$
declare
  changed_item_id uuid;
begin
  select item_id into changed_item_id
    from marketplace_listing
    where account_id = new.account_id and id = new.listing_id;
  if changed_item_id is not null then
    perform pg_notify('item_change', changed_item_id::text);
  end if;
  return null;
end;
$$;

create trigger marketplace_operation_item_change_notify
  after insert or update on marketplace_operation
  for each row execute function item_change_notify();

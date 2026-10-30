-- Unlinking a marketplace removes that marketplace's data from the account (docs/features/privacy.md,
-- Unlinking a marketplace): its listings, the items only its import brought in, its sales with
-- their Pack check orders, its offers, tasks, events, and the item history that names it. The
-- history of what Listora did on its listings stays for the owner, as it does when an item is
-- deleted, marked as from an unlinked account.

-- Why a listing (or an item) is only history now: its item was deleted, or its marketplace was
-- unlinked. An unlinked listing's item may still be in Listora (one listed elsewhere too), so
-- the listing no longer needs a `deleted_item`.
alter table deleted_item
  add column reason text not null default 'item_deleted'
    check (reason in ('item_deleted', 'unlinked'));

alter table deleted_listing
  add column reason text not null default 'item_deleted'
    check (reason in ('item_deleted', 'unlinked')),
  drop constraint deleted_listing_account_id_item_id_fkey;

-- A sale's delist run goes with the sale. A delist it started on another marketplace's listing
-- stays (the item did sell) and loses only its run, so an auto-delist may have none.
alter table marketplace_operation
  drop constraint marketplace_operation_auto_delist_has_run,
  add constraint marketplace_operation_auto_delist_has_run
    check (delist_run_id is null or origin = 'auto_delist'),
  drop constraint marketplace_operation_account_id_delist_run_id_fkey,
  add constraint marketplace_operation_account_id_delist_run_id_fkey
    foreign key (account_id, delist_run_id) references delist_run (account_id, id)
    on delete set null (delist_run_id);

-- The unlink deletes the item history that names the marketplace (`audit_log` rows of items that
-- stay). Like the retention job, it names the one append-only table it deletes from, in the
-- transaction-local setting `listora.unlink_delete`; every other direct change is still rejected.
create or replace function reject_direct_change() returns trigger
language plpgsql as $$
declare
  parent record;
  parent_deleted boolean;
begin
  if tg_op = 'DELETE' and (
    current_setting('listora.retention_delete', true) = tg_table_name
    or current_setting('listora.unlink_delete', true) = tg_table_name
  ) then
    return old;
  end if;
  if pg_trigger_depth() > 1 then
    for parent in
      select
        fk.confrelid::regclass as parent_table,
        (select string_agg(format('%I', attname), ', ' order by array_position(fk.confkey, attnum))
          from pg_attribute where attrelid = fk.confrelid and attnum = any (fk.confkey)) as parent_columns,
        (select string_agg(format('($1).%I', attname), ', ' order by array_position(fk.conkey, attnum))
          from pg_attribute where attrelid = fk.conrelid and attnum = any (fk.conkey)) as old_values
      from pg_constraint as fk
      where fk.conrelid = tg_relid and fk.contype = 'f' and fk.confdeltype in ('c', 'n')
    loop
      execute format(
        'select row(%1$s) is not null and not exists (select 1 from %2$s where (%3$s) = (%1$s))',
        parent.old_values, parent.parent_table, parent.parent_columns
      ) into parent_deleted using old;
      if parent_deleted then
        return coalesce(new, old);
      end if;
    end loop;
  end if;
  raise exception '%: direct % is not allowed', tg_table_name, lower(tg_op)
    using errcode = 'restrict_violation';
end;
$$;

-- The unlink finds the item history that names the marketplace.
create index audit_log_marketplace_idx on audit_log (account_id, (changes ->> 'marketplace'))
  where item_id is not null;

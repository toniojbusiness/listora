drop index audit_log_marketplace_idx;

create or replace function reject_direct_change() returns trigger
language plpgsql as $$
declare
  parent record;
  parent_deleted boolean;
begin
  if tg_op = 'DELETE' and current_setting('listora.retention_delete', true) = tg_table_name then
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

-- An auto-delist whose sale was unlinked away has no run; before, every one had its run.
update marketplace_operation set origin = 'user'
  where origin = 'auto_delist' and delist_run_id is null;

alter table marketplace_operation
  drop constraint marketplace_operation_account_id_delist_run_id_fkey,
  add constraint marketplace_operation_account_id_delist_run_id_fkey
    foreign key (account_id, delist_run_id) references delist_run (account_id, id),
  drop constraint marketplace_operation_auto_delist_has_run,
  add constraint marketplace_operation_auto_delist_has_run
    check ((origin = 'auto_delist') = (delist_run_id is not null));

-- Before, a deleted listing's item was always a deleted item: record the ones still in Listora.
insert into deleted_item (id, account_id, sku, title)
select distinct item.id, item.account_id, item.sku, item.title
from deleted_listing as listing
join inventory_item as item on item.account_id = listing.account_id and item.id = listing.item_id
where not exists (
  select 1 from deleted_item as deleted
  where deleted.account_id = listing.account_id and deleted.id = listing.item_id
);

alter table deleted_listing
  add constraint deleted_listing_account_id_item_id_fkey
    foreign key (account_id, item_id) references deleted_item (account_id, id) on delete cascade,
  drop column reason;

alter table deleted_item drop column reason;

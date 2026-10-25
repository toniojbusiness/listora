-- Reverts 20261025221245_privacy_retention.up.sql.

drop index connection_authorization_expires_idx;
drop index marketplace_connection_revoked_idx;
drop index inbound_event_processed_idx;
drop index operation_event_created_idx;

create or replace function reject_direct_change() returns trigger
language plpgsql as $$
declare
  parent record;
  parent_deleted boolean;
begin
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

drop table deletion_record;
drop table connection_deletion_object;
drop table connection_deletion;
drop table account_deletion_object;

alter table account_deletion
  drop column objects_deleted_at,
  drop column storage_prefixes,
  drop column user_id,
  drop column account_id;

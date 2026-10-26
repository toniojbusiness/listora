-- Privacy hardening (plan task T-33, docs/features/privacy.md): deletions that finish with a
-- verified completion record, unlinking a marketplace, and retention of logs and raw payloads.
--
-- Every deletion deletes the database rows at once, in the transaction that starts it, and
-- leaves a tombstone whose job does what needs outside services (the identity provider, the
-- marketplace's revocation endpoint, object storage), retrying until done. Before the job
-- deletes its tombstone it checks that nothing it was meant to delete remains, and writes a
-- `deletion_record`: what was deleted and when, without any personal data.

-- What the account deletion job checks: the deleted account (null when a member left an
-- account that stays) and user. Null for tombstones written before this migration.
alter table account_deletion
  add column account_id uuid,
  add column user_id uuid,
  -- Key prefixes that hold only the deleted account's objects (`photos/<account>/`), so the
  -- job also finds objects no row named (`account_deletion_object` has the ones rows named).
  add column storage_prefixes text[] not null default '{}',
  -- When every stored object of the account was deleted and checked gone.
  add column objects_deleted_at timestamptz;

-- The stored objects a deletion still has to delete: every object the deleted rows referenced
-- (public photo derivatives have unguessable keys, so they cannot be found by prefix later).
create table account_deletion_object (
  deletion_id uuid not null references account_deletion (id) on delete cascade,
  storage_key text not null check (char_length(storage_key) between 1 and 1024),
  primary key (deletion_id, storage_key)
);

-- A marketplace connection whose data was deleted (the seller unlinked it, its access stayed
-- revoked past the retention period, or the marketplace ended Listora's access) and whose job
-- has not finished: it asks the marketplace to revoke the grant and deletes the connection's
-- stored objects. Like `account_deletion`, it outlives the connection and its account, so it
-- has no `account_id`.
create table connection_deletion (
  id uuid primary key default uuidv7(),
  -- The deleted `marketplace_connection`'s id, for logs and the completion check.
  connection_id uuid not null,
  marketplace marketplace_id not null,
  reason text not null check (reason in ('unlinked', 'revoked', 'marketplace_terminated')),
  -- The grant's encrypted OAuth tokens, only while its revocation is pending; `none` when the
  -- connection held no grant to revoke (assisted, browser sessions, revoked already).
  token_ciphertext bytea,
  revocation text not null check (revocation in ('none', 'pending', 'revoked', 'manual')),
  requested_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  check ((revocation = 'pending') = (token_ciphertext is not null))
);

create table connection_deletion_object (
  deletion_id uuid not null references connection_deletion (id) on delete cascade,
  storage_key text not null check (char_length(storage_key) between 1 and 1024),
  primary key (deletion_id, storage_key)
);

-- The completion record of every finished deletion: its kind and reason, when it was asked
-- for and finished, and a summary of counts and outcomes (never an account, user, or
-- marketplace user id, email, or name). The retention job deletes records after two years.
create table deletion_record (
  -- The deletion's id (the tombstone's, or a new one for an eBay account deletion).
  id uuid primary key,
  kind text not null check (kind in ('account', 'connection', 'ebay_user')),
  reason text not null check (reason ~ '^[a-z][a-z_]*$'),
  marketplace marketplace_id,
  requested_at timestamptz not null,
  completed_at timestamptz not null default now(),
  summary jsonb not null default '{}' check (jsonb_typeof(summary) = 'object')
);

create index deletion_record_completed_idx on deletion_record (completed_at);

-- Retention: the retention job deletes expired rows of append-only tables (operation events,
-- AI usage events). It names the one table it deletes from in the transaction-local setting
-- `listora.retention_delete`; every other direct change is still rejected.
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

-- The retention job's scans.
create index operation_event_created_idx on operation_event (created_at);
create index inbound_event_processed_idx on inbound_event (processed_at)
  where processed_at is not null;
create index marketplace_connection_revoked_idx on marketplace_connection (last_error_at)
  where status = 'revoked';
create index connection_authorization_expires_idx on connection_authorization (expires_at);

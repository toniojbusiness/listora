-- Phone work wakes the app waiting for it (docs/features/phone-execution.md, "When the phone
-- runs"): work that becomes claimable notifies `phone_work` with its account's id, and the API
-- answers the app's wait (`waitForPhoneWork`) at once instead of at its next look. Inserted
-- work, and work whose claim ended or whose due time moved, notify; a claim renewing its lease
-- does not. Postgres delivers each notification when its transaction commits.
create function phone_work_notify() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT'
    or ((new.lease_expires_at is null or new.lease_expires_at <= now())
      and (new.lease_expires_at is distinct from old.lease_expires_at
        or new.due_at is distinct from old.due_at)) then
    perform pg_notify('phone_work', new.account_id::text);
  end if;
  return null;
end;
$$;

create trigger phone_work_notify
  after insert or update on phone_work
  for each row execute function phone_work_notify();

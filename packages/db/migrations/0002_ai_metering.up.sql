-- AI metering (plan task T-08). docs/architecture.md section 8 describes the model.
--
-- Every provider call, including a failed one, is one ai_usage_event. Events are the source
-- of truth for AI cost, so they are append-only, and a trigger adds each one to the account's
-- ai_usage_daily row for its UTC day in the same transaction. The rollup can therefore never
-- disagree with the events, whichever code path wrote them.

alter table ai_usage_event
  add column tier text not null default 'standard' check (tier in ('standard', 'premium')),
  -- A failed call is still metered with whatever usage the provider billed for it.
  add column outcome text not null default 'succeeded' check (outcome in ('succeeded', 'failed')),
  add column error_code text check (error_code ~ '^[a-z][a-z0-9_]*$'),
  -- Batch API calls are billed at half the token price.
  add column batch boolean not null default false,
  add constraint ai_usage_event_failed_has_error_code
    check ((outcome = 'failed') = (error_code is not null));

-- The defaults only filled rows that existed before this migration; callers must say which
-- tier and outcome a call had.
alter table ai_usage_event
  alter column tier drop default,
  alter column outcome drop default;

-- Append-only: events never change after they are written.
drop trigger ai_usage_event_set_updated_at on ai_usage_event;
alter table ai_usage_event drop column updated_at;

create trigger ai_usage_event_append_only
  before update or delete on ai_usage_event
  for each row execute function reject_direct_change();

alter table ai_usage_daily
  add column failed_calls integer not null default 0,
  add constraint ai_usage_daily_failed_calls_range check (failed_calls between 0 and calls);

create function add_ai_usage_to_daily() returns trigger
language plpgsql as $$
begin
  insert into ai_usage_daily as daily (
    account_id, usage_date, calls, failed_calls, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, images, web_searches, cost_micros
  ) values (
    new.account_id, (new.created_at at time zone 'UTC')::date, 1,
    case when new.outcome = 'failed' then 1 else 0 end, new.input_tokens, new.output_tokens,
    new.cache_read_tokens, new.cache_write_tokens, new.images, new.web_searches, new.cost_micros
  )
  on conflict (account_id, usage_date) do update set
    calls = daily.calls + excluded.calls,
    failed_calls = daily.failed_calls + excluded.failed_calls,
    input_tokens = daily.input_tokens + excluded.input_tokens,
    output_tokens = daily.output_tokens + excluded.output_tokens,
    cache_read_tokens = daily.cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = daily.cache_write_tokens + excluded.cache_write_tokens,
    images = daily.images + excluded.images,
    web_searches = daily.web_searches + excluded.web_searches,
    cost_micros = daily.cost_micros + excluded.cost_micros;
  return null;
end;
$$;

create trigger ai_usage_event_add_to_daily
  after insert on ai_usage_event
  for each row execute function add_ai_usage_to_daily();

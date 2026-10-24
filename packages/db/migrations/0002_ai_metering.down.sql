-- Reverts 0002_ai_metering.up.sql, restoring the 0001 shape of the AI metering tables.

drop trigger ai_usage_event_add_to_daily on ai_usage_event;
drop function add_ai_usage_to_daily();

alter table ai_usage_daily
  drop constraint ai_usage_daily_failed_calls_range,
  drop column failed_calls;

drop trigger ai_usage_event_append_only on ai_usage_event;

alter table ai_usage_event add column updated_at timestamptz not null default now();
create trigger ai_usage_event_set_updated_at
  before update on ai_usage_event
  for each row execute function set_updated_at();

alter table ai_usage_event
  drop constraint ai_usage_event_failed_has_error_code,
  drop column batch,
  drop column error_code,
  drop column outcome,
  drop column tier;

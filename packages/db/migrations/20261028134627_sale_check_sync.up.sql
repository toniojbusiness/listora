-- The seller's Sync now (docs/features/sync.md): a sale check asked for by opening the app, the
-- Sync now button, or a pull to refresh.
alter table sale_check_schedule drop constraint sale_check_schedule_next_reason_check;
alter table sale_check_schedule add constraint sale_check_schedule_next_reason_check
  check (next_reason in ('scheduled', 'email', 'retry', 'linked', 'offer', 'sync'));
alter table sale_check_run drop constraint sale_check_run_reason_check;
alter table sale_check_run add constraint sale_check_run_reason_check
  check (reason in ('scheduled', 'email', 'retry', 'linked', 'offer', 'sync'));

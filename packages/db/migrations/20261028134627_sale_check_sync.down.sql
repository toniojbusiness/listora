update sale_check_schedule set next_reason = 'email' where next_reason = 'sync';
update sale_check_run set reason = 'email' where reason = 'sync';
alter table sale_check_schedule drop constraint sale_check_schedule_next_reason_check;
alter table sale_check_schedule add constraint sale_check_schedule_next_reason_check
  check (next_reason in ('scheduled', 'email', 'retry', 'linked', 'offer'));
alter table sale_check_run drop constraint sale_check_run_reason_check;
alter table sale_check_run add constraint sale_check_run_reason_check
  check (reason in ('scheduled', 'email', 'retry', 'linked', 'offer'));

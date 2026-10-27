delete from phone_work where purpose = 'sale_history';
drop index phone_work_sale_history;
alter table phone_work drop constraint phone_work_purpose_check;
alter table phone_work add constraint phone_work_purpose_check
  check (purpose in ('operation', 'session_check', 'sale_check'));

alter table sale drop constraint sale_sale_check_run, drop column sale_check_run_id;

drop index sale_check_schedule_unhealthy_idx;
alter table sale_check_schedule
  drop constraint sale_check_schedule_alerted,
  drop constraint sale_check_schedule_unhealthy_since,
  drop column alerted_at,
  drop column unhealthy_since,
  drop column health,
  drop column last_error_message,
  drop column last_error_code,
  drop column failures_in_a_row,
  drop column last_succeeded_at;

drop table sale_check_run;

alter table automation_run drop column steps;

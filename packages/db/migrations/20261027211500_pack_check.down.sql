delete from automation_run where purpose = 'label_read';
alter table automation_run drop constraint automation_run_purpose_check;
alter table automation_run add constraint automation_run_purpose_check
  check (purpose in ('operation', 'sale_check', 'health'));

delete from phone_work where purpose = 'label_read';
drop index phone_work_label_read;
alter table phone_work drop constraint phone_work_purpose_check;
alter table phone_work add constraint phone_work_purpose_check
  check (purpose in ('operation', 'session_check', 'sale_check', 'sale_history'));

drop table sale_pack;
drop table sale_label;
drop table pack_check_setting;

delete from automation_run where purpose = 'import';
alter table automation_run drop constraint automation_run_purpose_check;
alter table automation_run add constraint automation_run_purpose_check
  check (purpose in ('operation', 'sale_check', 'health'));

delete from phone_work where purpose = 'listing_import';
drop index phone_work_listing_import;
alter table phone_work drop constraint phone_work_import_target;
alter table phone_work drop constraint phone_work_purpose_check;
alter table phone_work add constraint phone_work_purpose_check
  check (purpose in ('operation', 'session_check', 'sale_check', 'sale_history'));
alter table phone_work drop constraint phone_work_import;
alter table phone_work drop column import_id;

drop table listing_import_entry;
drop table listing_import;

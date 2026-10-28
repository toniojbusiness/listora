update sale_check_schedule set next_reason = 'email' where next_reason = 'offer';
update sale_check_run set reason = 'email' where reason = 'offer';
alter table sale_check_schedule drop constraint sale_check_schedule_next_reason_check;
alter table sale_check_schedule add constraint sale_check_schedule_next_reason_check
  check (next_reason in ('scheduled', 'email', 'retry', 'linked'));
alter table sale_check_run drop constraint sale_check_run_reason_check;
alter table sale_check_run add constraint sale_check_run_reason_check
  check (reason in ('scheduled', 'email', 'retry', 'linked'));

delete from automation_run where purpose in ('offer_check', 'offer_response');
alter table automation_run drop constraint automation_run_purpose_check;
alter table automation_run add constraint automation_run_purpose_check
  check (purpose in ('operation', 'sale_check', 'health', 'import', 'label_read'));

delete from phone_work where purpose in ('offer_check', 'offer_response');
drop index phone_work_offer_response_idx;
drop index phone_work_offer_check;
alter table phone_work drop constraint phone_work_offer_response_target;
alter table phone_work drop constraint phone_work_purpose_check;
alter table phone_work add constraint phone_work_purpose_check
  check (
    purpose in ('operation', 'session_check', 'sale_check', 'sale_history', 'listing_import', 'label_read')
  );
alter table phone_work drop constraint phone_work_offer_response;
alter table phone_work drop column offer_response_id;

delete from user_task where kind = 'answer_offer';
drop index user_task_open_offer;
alter table user_task drop constraint user_task_offer_target;
alter table user_task drop constraint user_task_kind_check;
alter table user_task add constraint user_task_kind_check
  check (
    kind in (
      'list_manually', 'delist_manually', 'edit_manually', 'confirm_sale', 'reconnect',
      'review_match', 'resolve_double_sale'
    )
  );
alter table user_task drop constraint user_task_offer;
alter table user_task drop column offer_id;

drop table offer_check;
drop table offer_response;
drop table marketplace_offer;

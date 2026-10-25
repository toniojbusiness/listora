-- Reverts 20261025050030_auto_delist.up.sql. Double-sale incidents have no place in the older
-- schema, so they are deleted.

drop index delist_run_item_idx;
drop index delist_run_unfinished_idx;
drop index user_task_double_sale_idx;

delete from user_task where kind = 'resolve_double_sale';

alter table user_task
  drop constraint user_task_double_sale_has_sale_and_item,
  drop constraint user_task_kind_check,
  add constraint user_task_kind_check
    check (kind in ('list_manually', 'delist_manually', 'edit_manually', 'confirm_sale', 'reconnect', 'review_match')),
  drop constraint user_task_sale_fkey,
  drop column sale_id;

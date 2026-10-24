-- Reverts 0009_listing_content.up.sql. Edit tasks have no place in the older schema, so they
-- are deleted; operation content is dropped.

delete from user_task where kind = 'edit_manually';

alter table user_task
  drop constraint user_task_manual_listing_task_has_listing,
  add constraint user_task_manual_listing_task_has_listing
    check (kind not in ('list_manually', 'delist_manually') or listing_id is not null),
  drop constraint user_task_kind_check,
  add constraint user_task_kind_check
    check (kind in ('list_manually', 'delist_manually', 'confirm_sale', 'reconnect', 'review_match'));

alter table marketplace_operation
  drop constraint marketplace_operation_content_by_kind,
  drop column content;

-- Listing content on operations, and assisted edit tasks (docs/architecture.md section 4).
--
-- An operation that puts content on a marketplace (create, revise, relist) stores the item
-- snapshot and the marketplace variant it publishes, in Listora's terms. Each attempt builds the
-- marketplace payload from it, so every attempt sends the same listing even when the item is
-- edited meanwhile, and the desired state a read-back checks comes from the same content.

alter table marketplace_operation
  add column content jsonb check (jsonb_typeof(content) = 'object'),
  add constraint marketplace_operation_content_by_kind
    check ((kind in ('create', 'revise', 'relist')) = (content is not null));

-- Assisted price and detail changes: the user edits the listing in the marketplace app.
alter table user_task
  drop constraint user_task_kind_check,
  add constraint user_task_kind_check
    check (kind in ('list_manually', 'delist_manually', 'edit_manually', 'confirm_sale', 'reconnect', 'review_match')),
  drop constraint user_task_manual_listing_task_has_listing,
  add constraint user_task_manual_listing_task_has_listing
    check (kind not in ('list_manually', 'delist_manually', 'edit_manually') or listing_id is not null);

alter table marketplace_operation
  drop constraint marketplace_operation_content_by_kind;
update marketplace_operation set content = null where kind = 'refresh';
alter table marketplace_operation
  add constraint marketplace_operation_content_by_kind
    check ((kind in ('create', 'revise', 'relist')) = (content is not null));

alter table listing_refresh_setting
  drop column relist_to_refresh;

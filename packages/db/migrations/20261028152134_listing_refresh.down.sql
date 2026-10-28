alter table inventory_item
  drop constraint inventory_item_refresh_custom_hours,
  drop column refresh_custom_hours,
  drop column refresh_cadence;

drop table listing_refresh_setting;

alter table marketplace_operation
  drop constraint marketplace_operation_origin_check,
  add constraint marketplace_operation_origin_check
    check (origin in ('user', 'auto_delist', 'reprice_rule')),
  drop constraint marketplace_operation_kind_check,
  add constraint marketplace_operation_kind_check
    check (kind in ('create', 'revise', 'price', 'end', 'relist', 'mark_sold', 'verify'));

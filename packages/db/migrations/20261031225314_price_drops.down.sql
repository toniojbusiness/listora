drop index marketplace_operation_price_drop_idx;

alter table marketplace_operation
  drop constraint marketplace_operation_price_drop_rule_origin,
  drop constraint marketplace_operation_price_drop_rule,
  drop column price_drop_rule_id;

drop table price_drop_rule;

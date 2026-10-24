-- Reverts 0001_schema_v1.up.sql, leaving an empty schema. Every object it created is dropped
-- by name (no CASCADE), so a missed dependency fails loudly instead of being dropped silently.

drop view delist_run_listing;

drop table audit_log;
drop table usage_counter;
drop table entitlement;
drop table subscription;
drop table pricing_snapshot;
drop table expense;
drop table fee_line;
drop table user_task;
drop table operation_event;
drop table marketplace_operation;
drop table delist_run;
drop table sale;
drop table inbound_event;
drop table marketplace_listing;
drop table marketplace_connection;
drop table ai_usage_daily;
drop table ai_usage_event;
alter table inventory_item drop constraint inventory_item_account_id_id_accepted_analysis_id_fkey;
drop table ai_analysis;
drop table photo;
drop table inventory_item;
drop table storage_location;
drop table sku_sequence;
drop table membership;
drop table app_user;
drop table account;

drop function create_sku_sequence();
drop function reject_append_only_change();
drop function bump_version();
drop function set_updated_at();

drop domain marketplace_id;
drop domain currency_code;

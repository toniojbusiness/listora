-- Reverts 20261025043646_ebay_notifications.up.sql.

alter table marketplace_connection drop column orders_polled_through;
drop index inbound_event_external_user_idx;
alter table inbound_event drop column external_user_id;

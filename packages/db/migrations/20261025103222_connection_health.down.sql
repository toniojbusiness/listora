-- Reverts 20261025103222_connection_health.up.sql.

alter table marketplace_connection
  drop column check_requested_at,
  drop column last_checked_at;

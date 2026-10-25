-- Reverts 0014_marketplace_connect.up.sql.

drop index marketplace_connection_external_user_idx;

drop table connection_authorization;

alter table marketplace_connection
  drop constraint marketplace_connection_revoked_holds_no_token,
  drop constraint marketplace_connection_error_complete,
  drop column last_error_at,
  drop column last_error_code,
  drop column granted_at;

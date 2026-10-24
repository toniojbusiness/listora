-- Reverts 0007_pending_listing_id.up.sql. The operation-level columns come back empty.

alter table marketplace_operation
  add column external_listing_id text,
  add column remote_revision bigint check (remote_revision >= 0);

alter table marketplace_listing
  drop constraint marketplace_listing_pending_external_id_unique,
  drop constraint marketplace_listing_pending_id_is_new,
  drop column pending_remote_revision,
  drop column pending_external_listing_id;

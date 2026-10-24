-- Reverts 0006_read_freshness.up.sql.

alter table marketplace_operation
  drop column remote_revision,
  drop column external_listing_id;

alter table marketplace_listing
  drop column remote_revision;

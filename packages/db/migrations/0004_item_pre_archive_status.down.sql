-- Reverts 0004_item_pre_archive_status.up.sql.

alter table inventory_item drop constraint inventory_item_pre_archive_status_iff_archived;
alter table inventory_item drop column pre_archive_status;

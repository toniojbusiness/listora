-- Fails while a deleted item's operations exist: they have no listing to go back to.
drop index marketplace_operation_deleted_listing_idx;

alter table marketplace_operation
  drop constraint marketplace_operation_has_listing,
  drop constraint marketplace_operation_account_id_deleted_listing_id_fkey,
  drop constraint marketplace_operation_account_id_listing_id_fkey,
  add constraint marketplace_operation_account_id_listing_id_fkey
    foreign key (account_id, listing_id) references marketplace_listing (account_id, id),
  drop column deleted_listing_id,
  alter column listing_id set not null;

drop table deleted_listing;
drop table deleted_item;

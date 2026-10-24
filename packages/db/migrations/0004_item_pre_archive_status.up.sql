-- The status an archived item had before it was archived (plan task T-05). Unarchiving uses it
-- to tell an item that was never sold, which may go back to draft or ready, from one that was
-- listed, sold, or shipped, whose status stays server-owned.
alter table inventory_item
  add column pre_archive_status text
    check (pre_archive_status in ('draft', 'ready', 'listed', 'sold_pending_delist', 'sold', 'shipped'));

-- Items archived before this column existed count as drafts; one with a sale still cannot be
-- unarchived, since the API also refuses items that have a sale.
update inventory_item set pre_archive_status = 'draft' where status = 'archived';

alter table inventory_item
  add constraint inventory_item_pre_archive_status_iff_archived
    check ((status = 'archived') = (pre_archive_status is not null));

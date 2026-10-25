-- Auto-delist (plan task T-20, docs/features/auto-delist.md): double-sale incidents, which are
-- urgent user tasks about a sale, and the indexes delist runs are read by.

alter table user_task
  -- The sale a task is about: for `resolve_double_sale`, the later sale of an item that had
  -- already sold. Deleted with the sale.
  add column sale_id uuid,
  add constraint user_task_sale_fkey
    foreign key (account_id, sale_id) references sale (account_id, id) on delete cascade,
  drop constraint user_task_kind_check,
  add constraint user_task_kind_check
    check (kind in ('list_manually', 'delist_manually', 'edit_manually', 'confirm_sale', 'reconnect', 'review_match', 'resolve_double_sale')),
  add constraint user_task_double_sale_has_sale_and_item
    check (kind <> 'resolve_double_sale' or (sale_id is not null and item_id is not null));

-- One double-sale incident per later sale and item, so recording a sale again opens none.
create unique index user_task_double_sale_idx on user_task (account_id, sale_id, item_id)
  where kind = 'resolve_double_sale';

-- The SLA job reads the runs that are not completed, oldest first; an item's page reads its runs.
create index delist_run_unfinished_idx on delist_run (created_at) where status <> 'completed';
create index delist_run_item_idx on delist_run (account_id, item_id);

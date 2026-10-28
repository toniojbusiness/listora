drop index inventory_item_haul_idx;

alter table inventory_item
  drop constraint inventory_item_haul_whole,
  drop constraint inventory_item_account_id_haul_id_fkey,
  drop column haul_joined_at,
  drop column haul_id;

drop table haul;

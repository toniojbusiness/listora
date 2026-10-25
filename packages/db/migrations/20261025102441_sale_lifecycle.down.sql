-- Reverts 20261025102441_sale_lifecycle.up.sql. The older schema has no `shipped` sale, so a
-- shipped sale goes back to `confirmed`.

alter table fee_line
  drop column fee_table_version,
  drop column description;

alter table sale_item
  drop constraint sale_item_relist_decided_has_time,
  drop column relist_decided_at,
  drop column relist_decision;

update sale set status = 'confirmed' where status = 'shipped';

alter table sale
  drop constraint sale_returned_has_returned_at,
  drop constraint sale_canceled_has_canceled_at,
  drop constraint sale_shipped_has_shipped_at,
  drop column shipping_cost_cents,
  drop column returned_at,
  drop column canceled_at,
  drop column shipped_at,
  drop column confirmed_at,
  drop constraint sale_status_check,
  add constraint sale_status_check
    check (status in ('detected', 'confirmed', 'canceled', 'returned'));

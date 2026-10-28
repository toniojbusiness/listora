-- Sold items' photos (docs/features/sales.md, "Sales history"): a Mercari sale
-- recorded from a check that sent no sold listing (an app built before sold items) has a sold
-- item with no photos. Each such connection's next check reads its whole sales history once
-- more, and every recorded sale whose sold item still has no photos gets its sold listing's.
update sale_check_schedule schedule
set checked_through = null
where schedule.marketplace = 'mercari'
  and exists (
    select 1
    from sale
    join sale_item on sale_item.sale_id = sale.id
    where sale.account_id = schedule.account_id
      and sale.marketplace = schedule.marketplace
      and not exists (select 1 from photo where photo.item_id = sale_item.item_id)
  );

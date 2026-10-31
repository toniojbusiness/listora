-- A call that rested on eBay's sold listings is kept as the AI estimate's (its nearest older
-- basis) before the check without `market_sold` comes back.
update item_scan set basis = 'ai_estimate' where basis = 'market_sold';
alter table item_scan drop constraint item_scan_basis_check;
alter table item_scan add constraint item_scan_basis_check
  check (basis in ('own_history', 'web_info', 'ai_estimate', 'none'));

alter table market_comparison drop column sold_total;

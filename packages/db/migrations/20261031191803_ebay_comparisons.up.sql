-- eBay's comparisons in the thrift scan (docs/features/thrift-scan.md, "eBay"): eBay shows a
-- visitor its sold listings, so a read also answers how many its whole sold search has (eBay's
-- last 90 days), the sold pace the trend read weighs; and a call may rest on what close matches
-- sold for there (`market_sold`) when the household's own sales are too few.
alter table market_comparison
  add column sold_total integer check (sold_total >= 0);

alter table item_scan drop constraint item_scan_basis_check;
alter table item_scan add constraint item_scan_basis_check
  check (basis in ('own_history', 'market_sold', 'web_info', 'ai_estimate', 'none'));

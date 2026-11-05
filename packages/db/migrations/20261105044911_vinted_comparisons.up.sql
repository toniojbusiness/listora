-- Vinted's comparisons in the thrift scan (docs/features/thrift-scan.md, "Vinted"): the
-- logged-out reads of Vinted's public search, kept like every other marketplace's (the budget,
-- the 24-hour cache, the pause after a check).
alter table market_comparison drop constraint market_comparison_marketplace_check;
alter table market_comparison add constraint market_comparison_marketplace_check
  check (marketplace in ('ebay', 'depop', 'poshmark', 'mercari', 'vinted'));

-- Vinted's comparison reads go with its comparisons: they are only a budget, a cache, and a
-- pause (deleted after 7 days anyway), never a seller's data.
delete from market_comparison where marketplace = 'vinted';
alter table market_comparison drop constraint market_comparison_marketplace_check;
alter table market_comparison add constraint market_comparison_marketplace_check
  check (marketplace in ('ebay', 'depop', 'poshmark', 'mercari'));

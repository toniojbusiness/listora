-- Vinted joins the marketplaces (docs/features/vinted.md). It starts assisted: Listora prepares
-- the listing and opens vinted.com, and the seller posts and confirms it. The thrift-scan
-- comparisons keep their own check, which Vinted joins with its comparisons (milestone M9).
alter domain marketplace_id drop constraint marketplace_id_known;
alter domain marketplace_id add constraint marketplace_id_known
  check (value in ('ebay', 'depop', 'poshmark', 'mercari', 'vinted'));

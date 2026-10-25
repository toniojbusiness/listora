-- The profit dashboard (docs/features/profit.md) reads an account's sales by when they sold;
-- without this index every report scans all of the account's sales.
create index sale_sold_at_idx on sale (account_id, sold_at);

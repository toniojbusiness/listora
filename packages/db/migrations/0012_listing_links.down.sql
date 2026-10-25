-- Reverts 0012_listing_links.up.sql.

drop index marketplace_listing_url_only_idx;
alter table marketplace_listing drop column user_confirmed_at;

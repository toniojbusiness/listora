-- Listings from a previous shop (docs/features/marketplace-linking.md#relinking-another-shop).
--
-- An account keeps one connection per marketplace. Unlinking it detaches its listings, and the
-- next link of that marketplace may be another shop (another seller's, or another account of the
-- same seller), so a link must not take them. `shop_unlinked_at` marks such a listing: it was on
-- a shop that was unlinked, so no later link adopts it. An import that finds it in the linked
-- shop (by its marketplace listing id) proves it is that shop's and attaches it again.
alter table marketplace_listing
  add column shop_unlinked_at timestamptz,
  add constraint marketplace_listing_unlinked_shop_has_no_connection
    check (shop_unlinked_at is null or connection_id is null);

-- Listings the user links from a share (plan task T-22): a listing they created on a
-- marketplace themselves, recorded from its URL and confirmed by them, never by the marketplace.

alter table marketplace_listing
  -- When the user last confirmed this listing's state themselves. It is kept apart from
  -- last_verified_at, which only an API read-back sets, so the user's word is never presented
  -- as the marketplace's.
  add column user_confirmed_at timestamptz;

-- A listing known only by a share short link (posh.mk/...) has no listing id until the
-- marketplace resolves it, which Listora never asks it to do. Its URL identifies it instead,
-- so the same short link cannot be linked to two items.
create unique index marketplace_listing_url_only_idx
  on marketplace_listing (account_id, marketplace, external_url)
  where external_listing_id is null and external_url is not null;

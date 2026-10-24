-- Read freshness (docs/architecture.md section 6): a read-back confirms an operation only when
-- it is not older than the newest revision Listora has already seen of the marketplace listing.

-- The newest revision seen of the marketplace listing `external_listing_id` names.
alter table marketplace_listing
  add column remote_revision bigint check (remote_revision >= 0);

alter table marketplace_operation
  -- A marketplace listing id this operation's send returned (a relist can issue a new one). The
  -- operation's later read-backs read this id; the listing row takes it once it is verified.
  add column external_listing_id text,
  -- The newest revision this operation saw of the marketplace listing it targets, including the
  -- revision its send was confirmed with.
  add column remote_revision bigint check (remote_revision >= 0);

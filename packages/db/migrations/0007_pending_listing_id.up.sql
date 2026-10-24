-- Pending marketplace listing ids (docs/architecture.md section 6). A listing id a marketplace
-- returns is kept on the listing at once, unverified, so every later operation on the listing
-- reaches it; a read-back that confirms it promotes it to `external_listing_id`. It replaces
-- the operation-level copy that 0003 added.

alter table marketplace_listing
  -- The newest listing id the marketplace returned that no read-back has confirmed yet (a
  -- relist can issue a new id while the old one stays ended).
  add column pending_external_listing_id text,
  -- The newest revision seen of the marketplace listing `pending_external_listing_id` names.
  add column pending_remote_revision bigint check (pending_remote_revision >= 0),
  add constraint marketplace_listing_pending_id_is_new
    check (pending_external_listing_id <> external_listing_id),
  add constraint marketplace_listing_pending_external_id_unique
    unique (account_id, marketplace, pending_external_listing_id);

alter table marketplace_operation
  drop column remote_revision,
  drop column external_listing_id;

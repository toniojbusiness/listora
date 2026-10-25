-- eBay notifications and order sync (plan task T-17): signed webhooks, the 5-minute order poll
-- backstop, and the purge that eBay's Marketplace Account Deletion notification requires.

alter table inbound_event
  -- The marketplace's immutable id of the user the event is about (eBay userId), so deleting
  -- that user's data finds every event they sent. Null where the source names no user.
  add column external_user_id text check (char_length(external_user_id) between 1 and 255);

create index inbound_event_external_user_idx
  on inbound_event (marketplace, external_user_id)
  where external_user_id is not null;

alter table marketplace_connection
  -- How far the order poll has read the seller's orders: every order last changed before this
  -- time has been seen. Null until the first poll succeeds.
  add column orders_polled_through timestamptz;

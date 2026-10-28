-- Read-only connections (docs/features/read-only.md).
--
-- A seller can mark a marketplace connection read only: Listora still reads the account
-- (imports, listings, sold items, sales, offers, sale checks) but never changes anything on it.
-- Every write path refuses on such a connection: queueing an operation, the engine's step before
-- it sends, the hand-off of a script to the browser runner or the phone, and the phone runtime.
-- Automatic work (the delists after a sale) skips it and queues nothing.
alter table marketplace_connection
  add column read_only boolean not null default false;

-- The connection health dashboard (plan task T-25): when Listora last heard from the
-- marketplace about a connection, and the seller's "Retry check".

alter table marketplace_connection
  -- When the latest health check or use of the connection finished, whatever it found. Null
  -- until the first one.
  add column last_checked_at timestamptz,
  -- When the seller last asked Listora to check the connection now. The check is pending while
  -- this is later than `last_checked_at`.
  add column check_requested_at timestamptz;

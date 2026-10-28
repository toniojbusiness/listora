-- Sales history (docs/features/sales.md, "Sales history"): a marketplace's sale checks also
-- record the sales of listings Listora doesn't have, each as a sold item, and the first check of
-- a connection reads the seller's whole sales history.

-- A sale from the seller's sales history (it sold before Listora watched the marketplace):
-- recorded only, with no auto-delist, delist, or notification, and never asked to ship.
alter table sale drop constraint sale_detection_source_check;
alter table sale add constraint sale_detection_source_check
  check (detection_source in ('webhook', 'poll', 'email', 'manual', 'history'));

-- Where a connection's sales history ends: a sale that sold before it is history, one after it
-- a sale Listora acts on. A new connection's is when it was linked (its first check is due at
-- once); an existing one's is now, this deploy, so no sale a check finds from before acts.
alter table sale_check_schedule add column history_until timestamptz not null default now();

-- Every connection's next check reads its whole sales history once: until now a check dropped
-- the sales of listings Listora didn't have, and the next checks read only since the last.
update sale_check_schedule set checked_through = null;

-- Sales history (docs/features/sales.md, "Sales history"): a marketplace's sale checks also
-- record the sales of listings Listora doesn't have, each as a sold item, and the first check of
-- a connection reads the seller's whole sales history.

-- A sale that sold before its marketplace was connected, found in the seller's sales history:
-- Listora wasn't watching then, so it never asks to ship it (Today, Pack check).
alter table sale drop constraint sale_detection_source_check;
alter table sale add constraint sale_detection_source_check
  check (detection_source in ('webhook', 'poll', 'email', 'manual', 'history'));

-- Every connection's next check reads its whole sales history once: until now a check dropped
-- the sales of listings Listora didn't have, and the next checks read only since the last.
update sale_check_schedule set checked_through = null;

-- Reverts the matching .up.sql. The batches' items stay as items; only the grouping goes.

drop table item_batch_item;
drop table item_batch;

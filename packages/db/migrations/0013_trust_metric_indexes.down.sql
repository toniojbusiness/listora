-- Reverts 0013_trust_metric_indexes.up.sql.

drop index marketplace_operation_unfinished_idx;
drop index operation_event_settled_idx;

-- Nothing to undo: reverting this one-off must never make the shop writable again. The flag
-- goes away only with its column (20261028061656_connection_read_only).
select 1;

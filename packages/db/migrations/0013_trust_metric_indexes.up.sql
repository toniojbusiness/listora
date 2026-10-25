-- Indexes for the trust metrics job (packages/observability), which reads across every account
-- once a minute: operations that settled in the last minutes and the unfinished operations.
-- Without them each tick would scan tables that only grow. Today's AI cost per account reads
-- ai_usage_daily_date_idx from 0011_ai_controls.

create index operation_event_settled_idx on operation_event (created_at)
  where to_status in ('succeeded', 'failed');

create index marketplace_operation_unfinished_idx on marketplace_operation (status)
  where status in ('queued', 'running', 'retrying', 'verifying', 'needs_user_action');

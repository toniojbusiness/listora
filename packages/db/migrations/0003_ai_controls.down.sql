-- Reverts 0003_ai_controls.up.sql.

drop index ai_usage_event_created_idx;
drop index ai_usage_daily_date_idx;

drop table ai_control_audit;
drop table ai_account_block;
drop table ai_kill_switch;

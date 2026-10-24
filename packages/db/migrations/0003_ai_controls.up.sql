-- AI cost controls (plan task T-29). docs/architecture.md section 8 describes how they are used.
--
-- Operators turn the global AI kill switch and per-account AI blocks on and off with
-- `npm run admin`. Each change and its audit row are written in one transaction, so the
-- audit trail cannot miss a change.

-- The global kill switch, as exactly one row. Engaged, it refuses every AI call for every
-- account, like AI_KILL_SWITCH=on, but takes effect without a deploy. It is a platform
-- setting, so it has no account_id.
create table ai_kill_switch (
  singleton boolean primary key default true check (singleton),
  engaged boolean not null default false,
  -- Who made the last change and why; null until the first change.
  changed_by text check (char_length(changed_by) between 1 and 200),
  reason text check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_kill_switch_change_is_attributed check ((changed_by is null) = (reason is null))
);

insert into ai_kill_switch default values;

create trigger ai_kill_switch_set_updated_at
  before update on ai_kill_switch
  for each row execute function set_updated_at();

-- Accounts an operator has blocked from AI. A row means blocked; unblocking deletes it, and
-- ai_control_audit keeps the history.
create table ai_account_block (
  account_id uuid primary key references account (id) on delete cascade,
  blocked_by text not null check (char_length(blocked_by) between 1 and 200),
  reason text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default now()
);

-- Append-only audit trail of every change to the AI controls. Rows about an account go away
-- with the account; kill switch rows have no account and are kept.
create table ai_control_audit (
  id uuid primary key default uuidv7(),
  action text not null
    check (action in ('kill_switch_on', 'kill_switch_off', 'account_block_on', 'account_block_off')),
  -- The blocked or unblocked account; null for the kill switch.
  account_id uuid references account (id) on delete cascade,
  actor text not null check (char_length(actor) between 1 and 200),
  reason text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default now(),
  constraint ai_control_audit_account_matches_action
    check ((account_id is null) = (action like 'kill\_switch\_%'))
);

create index ai_control_audit_created_idx on ai_control_audit (created_at);
create index ai_control_audit_account_idx on ai_control_audit (account_id, created_at)
  where account_id is not null;

create trigger ai_control_audit_append_only
  before update or delete on ai_control_audit
  for each row execute function reject_direct_change();

-- Cost reports and the spend check read a period across every account. The rollup's primary
-- key, (account_id, usage_date), and the event index on (account_id, created_at) serve
-- per-account reads only.
create index ai_usage_daily_date_idx on ai_usage_daily (usage_date);
create index ai_usage_event_created_idx on ai_usage_event (created_at);

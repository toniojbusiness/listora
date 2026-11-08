-- A phone call that continues a session the phone is already in (a send's read-back after the
-- send, a create's lookup before it) is the same visit to the marketplace as the run's first
-- call: it is recorded, but the seller's share of runs and the pause between sessions count
-- only first calls (docs/features/phone-execution.md, "How a phone run works").
alter table automation_run
  add column continues_session boolean not null default false;

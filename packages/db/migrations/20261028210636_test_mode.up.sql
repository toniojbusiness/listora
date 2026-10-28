-- Test mode (docs/features/test-mode.md): the deployment owner's account may turn on every
-- marketplace feature that is built but has not passed live, to live-test it; customers never
-- can. Each run of such a feature in Test mode is kept in `feature_test_run`, the owner's log,
-- so a passed run can be cited when the feature is marked verified.
alter table account add column test_mode boolean not null default false;

create table feature_test_run (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references account (id) on delete cascade,
  marketplace marketplace_id not null,
  feature text not null check (char_length(feature) between 1 and 50),
  outcome text not null check (outcome in ('passed', 'failed')),
  -- What ran: the operation, the offer answer, or the connection whose read it was.
  subject_id uuid not null,
  -- A failure's code and the reader's own words (sanitized: no page text, nothing typed).
  error_code text check (char_length(error_code) between 1 and 100),
  detail text check (char_length(detail) between 1 and 500),
  created_at timestamptz not null default now(),
  constraint feature_test_run_error check ((outcome = 'failed') or (error_code is null))
);

-- The admin view lists an account's runs, newest first.
create index feature_test_run_account_idx on feature_test_run (account_id, created_at desc);

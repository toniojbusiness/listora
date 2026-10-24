-- API idempotency (plan task T-05). Every POST carries an `Idempotency-Key` header; the first
-- successful response is stored here, in the same transaction as the change it reports, so a
-- retry with the same key replays it instead of repeating the action (see
-- packages/api-contract/README.md). A request that fails rolls back and stores nothing.
--
-- A row is written once and never updated. Expired rows are deleted in small batches by later
-- POSTs (`runIdempotent` in apps/api), and every row goes with its account.
create table idempotency_record (
  account_id uuid not null references account (id) on delete cascade,
  key text not null check (char_length(key) between 1 and 255),
  -- The contract operationId and a sha256 over the operation, path parameters, and body, so the
  -- same key sent with a different request is rejected instead of replayed.
  operation_id text not null check (operation_id ~ '^[a-z][A-Za-z0-9]*$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  response_status integer not null check (response_status between 200 and 299),
  response_body jsonb,
  created_at timestamptz not null default now(),
  -- Kept for at least 24 hours (the contract's promise); expired rows are treated as absent.
  expires_at timestamptz not null,
  primary key (account_id, key),
  constraint idempotency_record_expires_after_creation check (expires_at > created_at)
);

create index idempotency_record_expires_idx on idempotency_record (expires_at);

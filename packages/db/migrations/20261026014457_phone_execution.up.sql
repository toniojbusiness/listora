-- On-phone execution (docs/features/phone-execution.md).
--
-- Some marketplaces refuse Listora's cloud browser (Depop blocks its address, Mercari shows it
-- a bot check, Poshmark serves its pages without their data), so their automated steps run in
-- the iPhone app instead: in the seller's own session, on their own device and network. The
-- server keeps the one operation queue; each connection says where its automated steps run,
-- and the phone takes the steps handed to it from `phone_work`.

-- The devices the seller runs the app on: the one that runs a connection's steps, and where
-- push notifications go.
create table app_device (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  -- Made by the app on its first start and kept in its Keychain; the API names devices by it.
  installation_id uuid not null,
  user_id uuid not null references app_user (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  platform text not null check (platform in ('ios')),
  app_version text check (char_length(app_version) between 1 and 50),
  -- The version of phone calls its runtime speaks; a call is handed only to a device that
  -- speaks the server's.
  runtime_version integer check (runtime_version > 0),
  -- APNs device token (hex), and the APNs environment it belongs to.
  push_token text check (push_token ~ '^[0-9a-f]+$' and char_length(push_token) between 16 and 400),
  push_environment text check (push_environment in ('sandbox', 'production')),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  unique (account_id, installation_id),
  constraint app_device_push check ((push_token is null) = (push_environment is null))
);

-- A token belongs to one installation: registering it elsewhere moves it.
create unique index app_device_push_token on app_device (push_token) where push_token is not null;

create trigger app_device_set_updated_at
  before update on app_device
  for each row execute function set_updated_at();

-- Where a connection's automated steps run: Listora's cloud browser runner, or the phone that
-- linked it. API and assisted steps run where they always do.
alter table marketplace_connection
  add column runs_on text not null default 'cloud' check (runs_on in ('cloud', 'phone')),
  add column phone_device_id uuid,
  add constraint marketplace_connection_phone_device foreign key (account_id, phone_device_id)
    references app_device (account_id, id) on delete set null (phone_device_id);

-- Which host ran an automation run: the cloud browser runner, or the phone.
alter table automation_run
  add column host text not null default 'runner' check (host in ('runner', 'phone'));

-- The marketplaces that refuse the cloud runner run on the phone; only eBay stays in the cloud.
update marketplace_connection set runs_on = 'phone'
where marketplace in ('poshmark', 'mercari', 'depop');

-- Work handed to the phone: an automated operation step, a session check, or a sale check. A
-- row waits from the moment it is due; the phone claims it (a lease), runs its script calls one
-- at a time, and the row goes when the result is recorded.
create table phone_work (
  id uuid primary key default uuidv7(),
  account_id uuid not null references account (id) on delete cascade,
  connection_id uuid not null,
  marketplace marketplace_id not null,
  purpose text not null check (purpose in ('operation', 'session_check', 'sale_check')),
  operation_id uuid,
  -- The session check's link (`session_check.check_id`).
  check_id uuid,
  -- Lower runs first, as in the job queue: delists after a sale go ahead.
  priority integer not null default 0,
  -- Since when the work waits for the phone ("waiting on your iPhone for 12 minutes").
  waiting_since timestamptz not null default now(),
  -- Not before then.
  due_at timestamptz not null default now(),
  -- When a background push last asked the phone to run it.
  notified_at timestamptz,
  -- The phone's run of it: when it was claimed, until when the claim holds, what the claim
  -- decided, the calls answered so far, and the one the phone is running now.
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  step jsonb,
  transcript jsonb not null default '[]',
  pending_call jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  foreign key (account_id, connection_id, marketplace)
    references marketplace_connection (account_id, id, marketplace) on delete cascade,
  foreign key (account_id, operation_id)
    references marketplace_operation (account_id, id) on delete cascade,
  constraint phone_work_target check (
    (operation_id is not null) = (purpose = 'operation')
    and (check_id is not null) = (purpose = 'session_check')
  ),
  constraint phone_work_claim check (
    (claimed_at is null) = (lease_expires_at is null) and (claimed_at is null) = (step is null)
  ),
  constraint phone_work_transcript check (jsonb_typeof(transcript) = 'array')
);

create unique index phone_work_operation on phone_work (account_id, operation_id)
  where operation_id is not null;
create unique index phone_work_session_check on phone_work (account_id, connection_id)
  where purpose = 'session_check';
create unique index phone_work_sale_check on phone_work (account_id, connection_id)
  where purpose = 'sale_check';
create index phone_work_next on phone_work (account_id, connection_id, priority, due_at);
create index phone_work_lease on phone_work (lease_expires_at) where lease_expires_at is not null;

create trigger phone_work_set_updated_at
  before update on phone_work
  for each row execute function set_updated_at();

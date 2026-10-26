-- Email sale detection (docs/features/email-sales.md): each account's private forwarding address,
-- the "ask before auto-delist" setting, and what the app shows about forwarding.
--
-- A sale email itself is an `inbound_event` (source `email`): its parsed fields and a short
-- redacted excerpt, never the raw message, which is deleted once it is processed.
create table sale_email_inbox (
  account_id uuid primary key references account (id) on delete cascade,
  -- The private part of the forwarding address `sales+<token>@<inbound domain>`: 100 random bits.
  address_token text not null unique check (address_token ~ '^[a-z2-7]{20}$'),
  -- On: a sale email creates a confirm task instead of recording the sale and delisting.
  ask_before_delist boolean not null default false,
  -- The latest email of any kind sent to the address.
  last_email_at timestamptz,
  -- The latest marketplace email that passed DKIM and SPF: forwarding works.
  last_verified_email_at timestamptz,
  -- The latest sale email Listora read.
  last_sale_email_at timestamptz,
  -- The email provider's forwarding confirmation (Gmail's code and link), shown to the user.
  confirmation_provider text check (char_length(confirmation_provider) between 1 and 64),
  confirmation_code text check (char_length(confirmation_code) between 1 and 64),
  confirmation_url text check (char_length(confirmation_url) between 1 and 2048),
  confirmation_received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sale_email_inbox_confirmation_complete check (
    (confirmation_received_at is null) = (confirmation_provider is null)
    and (confirmation_received_at is null or confirmation_code is not null or confirmation_url is not null)
  )
);

create trigger sale_email_inbox_set_updated_at
  before update on sale_email_inbox
  for each row execute function set_updated_at();

-- One confirm or review task per sale email, whichever process reads it first.
create unique index user_task_sale_email_key on user_task (account_id, (payload ->> 'inboundEventId'))
  where kind in ('confirm_sale', 'review_match') and payload ? 'inboundEventId';

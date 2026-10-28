-- Deleting an item keeps the history of its marketplace actions (docs/features/items.md, Deleting
-- an item). Before, an operation's plain foreign key to its listing refused the listing's delete,
-- so an item that had ever been published, ended, or canceled could never be deleted. Now the
-- delete records what the item and each listing were, and moves its operations onto that record:
-- `listing_id` is cleared (`on delete set null`) and `deleted_listing_id` keeps the link. The
-- operations' events, browser sessions, and phone work stay attached to them. These records are
-- for the owner's and operators' history only (`admin activity --item`); no seller view reads them.

-- What a deleted item was. Its id is the item's, so a search by the old id finds its history.
create table deleted_item (
  id uuid primary key,
  account_id uuid not null references account (id) on delete cascade,
  sku text not null,
  title text,
  deleted_at timestamptz not null default now(),
  unique (account_id, id)
);

-- What each listing of a deleted item was; its id is the listing's.
create table deleted_listing (
  id uuid primary key,
  account_id uuid not null references account (id) on delete cascade,
  item_id uuid not null,
  marketplace marketplace_id not null,
  -- The listing's status and marketplace id when its item was deleted (a live one stays up).
  status text not null
    check (status in ('draft', 'queued', 'publishing', 'active', 'ending', 'ended', 'sold', 'error', 'unknown', 'needs_user_action')),
  external_listing_id text,
  deleted_at timestamptz not null default now(),
  unique (account_id, id),
  foreign key (account_id, item_id) references deleted_item (account_id, id) on delete cascade
);

create index deleted_listing_item_idx on deleted_listing (account_id, item_id);

alter table marketplace_operation
  alter column listing_id drop not null,
  add column deleted_listing_id uuid,
  drop constraint marketplace_operation_account_id_listing_id_fkey,
  add constraint marketplace_operation_account_id_listing_id_fkey
    foreign key (account_id, listing_id) references marketplace_listing (account_id, id)
    on delete set null (listing_id),
  add constraint marketplace_operation_account_id_deleted_listing_id_fkey
    foreign key (account_id, deleted_listing_id) references deleted_listing (account_id, id),
  -- Every operation is on a listing Listora tracks or on a deleted item's; a delete that would
  -- leave one on neither (one enqueued meanwhile, never moved) fails instead.
  add constraint marketplace_operation_has_listing
    check (listing_id is not null or deleted_listing_id is not null);

create index marketplace_operation_deleted_listing_idx on marketplace_operation (account_id, deleted_listing_id)
  where deleted_listing_id is not null;

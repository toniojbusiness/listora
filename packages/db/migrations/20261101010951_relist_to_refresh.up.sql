-- Relisting to refresh (docs/features/listing-refresh.md): Depop shows only a new listing as new,
-- so its refresh posts a fresh copy and deletes the old listing, which resets its likes and
-- saves. It runs only for a seller who turns it on; every account starts with it off.
alter table listing_refresh_setting
  add column relist_to_refresh boolean not null default false;

-- A refresh that relists carries the content its fresh copy posts; any other refresh carries
-- none, and the content kinds still always carry theirs.
alter table marketplace_operation
  drop constraint marketplace_operation_content_by_kind,
  add constraint marketplace_operation_content_by_kind
    check (
      case
        when kind in ('create', 'revise', 'relist') then content is not null
        when kind = 'refresh' then true
        else content is null
      end
    );

-- Any Vinted row (a listing, a connection, a sale) makes the domain check fail, so the rollback
-- stops rather than deleting a seller's data; remove that data deliberately first.
alter domain marketplace_id drop constraint marketplace_id_known;
alter domain marketplace_id add constraint marketplace_id_known
  check (value in ('ebay', 'depop', 'poshmark', 'mercari'));

-- The rest of a listing's variant (the API contract's `ListingVariant`), so a draft listing keeps
-- everything the seller reviewed until it is published: the marketplace's condition when it
-- differs from the item's, Depop's hashtags, and the item specifics as an ordered list of
-- `{name, values}` (item specifics have an order on the marketplace's page; an object would lose it).

alter table marketplace_listing
  add column condition text,
  add column hashtags text[] not null default '{}',
  drop constraint marketplace_listing_aspects_check,
  alter column aspects set default '[]';

update marketplace_listing set aspects = '[]' where aspects = '{}';

alter table marketplace_listing
  add constraint marketplace_listing_aspects_check check (jsonb_typeof(aspects) = 'array');

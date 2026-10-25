-- Reverts the matching .up.sql. Item specifics go back to the empty object they were before.

alter table marketplace_listing
  drop constraint marketplace_listing_aspects_check,
  alter column aspects set default '{}';

update marketplace_listing set aspects = '{}';

alter table marketplace_listing
  add constraint marketplace_listing_aspects_check check (jsonb_typeof(aspects) = 'object'),
  drop column hashtags,
  drop column condition;

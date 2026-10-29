-- A package whose tracking number retention cleared cannot get it back, so its record goes.
delete from sale_pack where tracking_number is null;
alter table sale_pack alter column tracking_number set not null;

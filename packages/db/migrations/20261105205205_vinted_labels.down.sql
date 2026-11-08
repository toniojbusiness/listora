alter table sale_label drop column label_format;
update sale_label set carrier = 'other' where carrier = 'speedx';
alter table sale_label drop constraint sale_label_carrier_check;
alter table sale_label add constraint sale_label_carrier_check
  check (carrier in ('usps', 'ups', 'fedex', 'dhl', 'other'));

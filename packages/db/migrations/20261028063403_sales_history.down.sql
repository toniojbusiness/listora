-- Sales found in a sales history read as any sale a check found; the history read is not undone.
alter table sale_check_schedule drop column history_until;
update sale set detection_source = 'poll' where detection_source = 'history';
alter table sale drop constraint sale_detection_source_check;
alter table sale add constraint sale_detection_source_check
  check (detection_source in ('webhook', 'poll', 'email', 'manual'));

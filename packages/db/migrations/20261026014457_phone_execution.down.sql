drop table phone_work;
alter table automation_run drop column host;
alter table marketplace_connection
  drop constraint marketplace_connection_phone_device,
  drop column phone_device_id,
  drop column runs_on;
drop table app_device;

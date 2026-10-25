drop table sale_check_schedule;
drop table automation_run;

-- Automation connections and their sessions cannot exist without automation mode; their
-- listings fall back to no connection (assisted).
update marketplace_listing set connection_id = null
  where connection_id in (select id from marketplace_connection where mode = 'automation');
delete from marketplace_connection where mode = 'automation';

alter table marketplace_connection drop constraint marketplace_connection_automation_session;
alter table marketplace_connection drop column credential_version;

comment on column marketplace_connection.token_ciphertext is null;

alter table marketplace_connection drop constraint marketplace_connection_mode_check;
alter table marketplace_connection add constraint marketplace_connection_mode_check
  check (mode in ('api', 'assisted'));

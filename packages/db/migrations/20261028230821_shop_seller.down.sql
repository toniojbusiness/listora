-- Connections keep their read-only setting (`read_only`), so nothing becomes writable here.
drop trigger marketplace_connection_keep_read_only_seller on marketplace_connection;
drop function keep_read_only_seller();
drop trigger marketplace_connection_protect_seller on marketplace_connection;
drop function protect_connection_seller();
drop table protected_seller;
drop table read_only_seller;

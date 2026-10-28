-- A one-off: the live Depop shop the owner linked on 2026-10-28 (about 05:49 UTC, its 118
-- listings imported right after) is a real seller's shop with real buyers that Listora must
-- never change, so its connection is read only from the moment this code deploys
-- (docs/features/read-only.md). The update names the connection by its id, its account, and its
-- marketplace, so it changes nothing in any other database (development, tests, staging), and it
-- changes nothing else about the connection.
update marketplace_connection
set read_only = true
where id = '01a1810e-62e9-723f-8a5a-19e2f44ce59e'
  and account_id = '01a1755b-25e4-780b-8bff-07839b296f3e'
  and marketplace = 'depop';

-- One listing under that connection is not the shop's: it was posted from the owner's own test
-- shop, and relinking the account's Depop left it under the live shop's connection. It loses its
-- connection, so no session (not even a read) ever runs for it there; it stays read only by the
-- account's Depop connection.
update marketplace_listing
set connection_id = null
where id = '01a17fd5-d9e5-768d-87df-f6707cf05b83'
  and account_id = '01a1755b-25e4-780b-8bff-07839b296f3e'
  and connection_id = '01a1810e-62e9-723f-8a5a-19e2f44ce59e'
  and marketplace = 'depop';

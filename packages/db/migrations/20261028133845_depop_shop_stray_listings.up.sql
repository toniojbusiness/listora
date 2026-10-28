-- A one-off, after 20261028061657_depop_shop_read_only: the rest of the owner's test-shop Depop
-- listings that relinking the account's Depop left under the live shop's connection. The owner
-- unlinked the test shop and then linked the live one (2026-10-28, about 05:49 UTC), and the link
-- took every Depop listing without a connection (docs/features/marketplace-linking.md). Besides
-- the one that migration detached (item TO-000004), three more were the test shop's: items
-- TO-000001, TO-000002, and TO-000003, each ended, with no Depop listing id, from before the live
-- shop was linked. The live shop's own listings (118, all imported after it was linked) stay
-- as they are, and so does the connection (read only).
--
-- Each update names the listings by id, account, connection, and marketplace, and checks their
-- state, so it changes nothing in any other database. Only Listora's records change.
update marketplace_listing
set connection_id = null, shop_unlinked_at = now()
where id in (
    '01a178f6-6565-7cc3-8d8d-979786137b58',
    '01a178f3-d61d-7c19-a8e5-77509eb091e8',
    '01a17bad-f8d4-7a3e-b5c2-e702975788ec'
  )
  and account_id = '01a1755b-25e4-780b-8bff-07839b296f3e'
  and connection_id = '01a1810e-62e9-723f-8a5a-19e2f44ce59e'
  and marketplace = 'depop'
  and status = 'ended'
  and external_listing_id is null;

-- The one detached before (TO-000004) is marked as from the previous shop too, so relinking the
-- live shop never takes it back.
update marketplace_listing
set shop_unlinked_at = now()
where id = '01a17fd5-d9e5-768d-87df-f6707cf05b83'
  and account_id = '01a1755b-25e4-780b-8bff-07839b296f3e'
  and connection_id is null
  and marketplace = 'depop';

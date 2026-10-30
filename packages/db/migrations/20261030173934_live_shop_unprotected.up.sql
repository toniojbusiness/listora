-- The live Depop shop is no longer protected (docs/features/read-only.md#one-off-the-live-depop-shop).
--
-- Migration 20261029233830_shop_read_only protected a real seller's live Depop shop by its
-- seller's digest, so Listora only ever read it, on any connection of any account. On 2026-10-30
-- the repository's owner lifted that: the shop's seller now has their own Listora account and
-- lists from it as any seller does. Its protection goes, and so does the read only it put on the
-- connections that hold the shop, so the shop is writable wherever it is linked and its Read only
-- switch works both ways. Nothing else about the shop, its connections, or its listings changes.
--
-- Only the digest is here, never the handle. Other protected shops stay protected.

-- 1. The shop is no longer protected.
delete from protected_seller
where marketplace = 'depop'
  and seller_digest = 'aad3b2ee04d134389b11cda5acb004bc341b2fa44bae5ad650d74d93426ee1f5';

-- 2. A connection that holds the shop was read only by its protection, whatever its owner set,
-- so it becomes writable. The triggers forget what that read only left on the account: the
-- seller kept read only (`read_only_seller`), and the account's marketplace setting
-- (`marketplace_read_only`), so a relink of the shop on that account is writable too.
update marketplace_connection
set read_only = false, read_only_carried = false
where marketplace = 'depop'
  and read_only
  and external_user_id is not null
  and seller_digest(external_user_id)
    = 'aad3b2ee04d134389b11cda5acb004bc341b2fa44bae5ad650d74d93426ee1f5';

-- 3. An account that still keeps the shop's seller read only (no connection of it holds the
-- shop) kept it only because of the protection, so it forgets the seller as well.
delete from read_only_seller
where marketplace = 'depop'
  and seller_digest(seller_id) = 'aad3b2ee04d134389b11cda5acb004bc341b2fa44bae5ad650d74d93426ee1f5';

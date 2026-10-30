-- The live Depop shop is protected again, by its seller's digest, as migration
-- 20261029233830_shop_read_only left it: every connection that holds it is read only (the
-- protection's trigger keeps the account's read-only seller and marketplace setting). Changes
-- already waiting for its listings are refused by the engine before they send.
insert into protected_seller (marketplace, seller_digest, reason)
values (
  'depop',
  'aad3b2ee04d134389b11cda5acb004bc341b2fa44bae5ad650d74d93426ee1f5',
  'A real seller''s live shop with real buyers, linked on 2026-10-28: Listora only ever reads it.'
)
on conflict (marketplace, seller_digest) do nothing;

update marketplace_connection
set read_only = true
where marketplace = 'depop'
  and external_user_id is not null
  and seller_digest(external_user_id)
    = 'aad3b2ee04d134389b11cda5acb004bc341b2fa44bae5ad650d74d93426ee1f5';

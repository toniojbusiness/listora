-- Pack check reads Depop's real receipts (docs/features/pack-check.md, "Reading labels"): what the
-- marketplace's order page last said of the order, and when its label stops being usable.

-- `to_ship`: the marketplace waits for the seller to ship it (Depop's `shipping_pending`), which
-- makes a sale from the sales history a package to pack too; `shipped` and `canceled` (shipped,
-- delivered, or refunded there): no package to pack. Null when the page doesn't say.
alter table sale_label add column order_state text
  check (order_state in ('to_ship', 'shipped', 'canceled'));
-- When the marketplace's label expires (Depop's `label_expires_at`), as the page shows it.
alter table sale_label add column label_expires_at timestamptz;

-- The sale lifecycle (plan task T-26, docs/features/sales.md): a sale is detected, confirmed,
-- and shipped, or canceled or returned; after a cancel or return the seller decides, per item,
-- whether to relist. Fee lines name what they are and, when estimated, the fee table they came
-- from.

alter table sale
  drop constraint sale_status_check,
  add constraint sale_status_check
    check (status in ('detected', 'confirmed', 'shipped', 'canceled', 'returned')),
  -- When the seller confirmed the sale, shipped it, or it was canceled or returned.
  add column confirmed_at timestamptz,
  add column shipped_at timestamptz,
  add column canceled_at timestamptz,
  add column returned_at timestamptz,
  -- What the seller paid to ship outside the payout (a label bought elsewhere). A label the
  -- marketplace deducts is a `shipping_label` fee line instead. Null until known.
  add column shipping_cost_cents bigint check (shipping_cost_cents >= 0),
  add constraint sale_shipped_has_shipped_at check (status <> 'shipped' or shipped_at is not null),
  add constraint sale_canceled_has_canceled_at
    check (status <> 'canceled' or canceled_at is not null),
  add constraint sale_returned_has_returned_at
    check (status <> 'returned' or returned_at is not null);

alter table sale_item
  -- Set when the sale is canceled or returned: `pending` until the seller decides whether to
  -- relist the item, then `relisted` or `declined`. Listora never relists by itself.
  add column relist_decision text check (relist_decision in ('pending', 'relisted', 'declined')),
  add column relist_decided_at timestamptz,
  add constraint sale_item_relist_decided_has_time
    check ((relist_decision in ('relisted', 'declined')) = (relist_decided_at is not null));

alter table fee_line
  -- What the marketplace or the fee table calls it, for example "Final value fee".
  add column description text check (char_length(description) between 1 and 200),
  -- The fee table (`@listora/pricing`) an estimated line was computed with.
  add column fee_table_version text check (char_length(fee_table_version) between 1 and 100);

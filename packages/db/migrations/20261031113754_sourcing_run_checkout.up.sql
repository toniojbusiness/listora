-- A sourcing run's checkout (docs/features/thrift-scan.md, "Checkout"): at the register the
-- seller enters what the haul cost, and the run's kept items become one haul (docs/features/
-- hauls.md), each costing its share. The run keeps the haul it became, when it was checked out,
-- and the miles driven for the trip when the seller gave them.
alter table sourcing_run
  add column haul_id uuid,
  add column checked_out_at timestamptz,
  add column miles integer check (miles between 0 and 2000),
  add constraint sourcing_run_account_id_haul_id_fkey
    foreign key (account_id, haul_id) references haul (account_id, id) on delete set null (haul_id),
  -- A run with a haul was checked out, and a checked-out run ended.
  add constraint sourcing_run_checkout_whole check (
    (haul_id is null or checked_out_at is not null)
    and (checked_out_at is null or ended_at is not null)
  );

-- One run per haul.
create unique index sourcing_run_haul_idx on sourcing_run (account_id, haul_id)
  where haul_id is not null;

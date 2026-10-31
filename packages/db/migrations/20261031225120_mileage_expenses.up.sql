-- Mileage and sourcing expenses (docs/features/expenses.md): a sourcing run's miles and its other
-- spend (parking, tolls, a bin store's entry fee) become rows of `expense`, so Reports can show
-- them for taxes. A mileage row keeps the miles, never a dollar amount: the deduction is the
-- year's miles at that year's standard mileage rate, which the seller can change later.
alter table expense
  add column kind text not null default 'spend' check (kind in ('mileage', 'spend')),
  add column miles integer check (miles between 1 and 2000),
  add column sourcing_run_id uuid,
  alter column amount_cents drop not null,
  add constraint expense_account_id_sourcing_run_id_fkey
    foreign key (account_id, sourcing_run_id) references sourcing_run (account_id, id)
    on delete set null (sourcing_run_id),
  -- A mileage row has miles and no amount; a spend row an amount and no miles.
  add constraint expense_kind_whole check (
    (kind = 'mileage' and miles is not null and amount_cents is null)
    or (kind = 'spend' and amount_cents is not null and miles is null)
  );

-- One mileage row per run.
create unique index expense_run_mileage_idx on expense (account_id, sourcing_run_id)
  where kind = 'mileage' and sourcing_run_id is not null;

-- A year's expenses, by day.
create index expense_incurred_on_idx on expense (account_id, incurred_on);

-- The standard mileage rate the seller uses for a year, in tenths of a cent per mile (725 is
-- 72.5 cents). Without a row the year uses the IRS business rate Listora knows for it, if any.
create table mileage_rate (
  account_id uuid not null references account (id) on delete cascade,
  year integer not null check (year between 2000 and 2100),
  tenth_cents_per_mile integer not null check (tenth_cents_per_mile between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, year)
);

create trigger mileage_rate_set_updated_at
  before update on mileage_rate
  for each row execute function set_updated_at();

-- The miles of runs checked out before this migration, on the haul's date.
insert into expense (account_id, incurred_on, category, kind, miles, sourcing_run_id)
select run.account_id, coalesce(haul.purchase_date, (run.started_at at time zone 'UTC')::date), 'Mileage', 'mileage', run.miles, run.id
from sourcing_run run
join haul on haul.account_id = run.account_id and haul.id = run.haul_id
where run.miles > 0;

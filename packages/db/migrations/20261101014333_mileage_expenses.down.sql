drop table mileage_rate;
drop index expense_incurred_on_idx;
drop index expense_run_mileage_idx;
delete from expense where kind = 'mileage';
alter table expense
  drop constraint expense_kind_whole,
  drop constraint expense_account_id_sourcing_run_id_fkey,
  alter column amount_cents set not null,
  drop column sourcing_run_id,
  drop column miles,
  drop column kind;

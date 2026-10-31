drop index sourcing_run_haul_idx;
alter table sourcing_run
  drop constraint sourcing_run_checkout_whole,
  drop constraint sourcing_run_account_id_haul_id_fkey,
  drop column miles,
  drop column checked_out_at,
  drop column haul_id;

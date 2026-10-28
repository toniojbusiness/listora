-- The seller's description style (docs/features/description-style.md): how the item analysis
-- writes their listing copy, one row per account. No row means Listora's default style; the
-- `depop` text replaces the default for the Depop draft. The text is instructions for the model,
-- written by the seller in Settings, at most 4,000 characters.
create table description_style (
  account_id uuid primary key references account (id) on delete cascade,
  depop text not null check (char_length(depop) between 1 and 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger description_style_set_updated_at
  before update on description_style
  for each row execute function set_updated_at();

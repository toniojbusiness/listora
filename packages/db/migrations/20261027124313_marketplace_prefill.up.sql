-- The marketplace pre-fill (docs/features/marketplace-prefill.md): what each marketplace's sell
-- form gets for an item, worked out on the review screen. The pre-fill itself is computed on
-- every read; these tables keep what it cannot recompute for free.
--
-- `item_prefill_answer`: the seller's taps on the review's questions (Girls or boys, a Mercari
-- category, a Depop size). An answer holds for the item details it was given for (`basis`, a hash
-- of the category, department, and size), so once those change the question is asked again.
create table item_prefill_answer (
  account_id uuid not null references account (id) on delete cascade,
  item_id uuid not null,
  key text not null
    check (key ~ '^(kids_gender|(depop|poshmark|mercari)\.(category|size))$'),
  value text not null check (char_length(value) between 1 and 300),
  basis text not null check (char_length(basis) = 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, item_id, key),
  foreign key (account_id, item_id) references inventory_item (account_id, id) on delete cascade
);

create trigger item_prefill_answer_set_updated_at
  before update on item_prefill_answer
  for each row execute function set_updated_at();

-- `item_prefill_pick`: the AI's pick for one question, kept so it is asked once. A question is the
-- item's details and the short list it chose from (`decision_hash`); a new list is a new question.
-- `value` is null when the AI could not tell, or a billed call failed: the seller is asked then,
-- and the AI is not paid again for the same question.
create table item_prefill_pick (
  account_id uuid not null references account (id) on delete cascade,
  item_id uuid not null,
  decision_hash text not null check (char_length(decision_hash) = 64),
  key text not null check (char_length(key) between 1 and 40),
  value text check (char_length(value) between 1 and 300),
  confidence real not null check (confidence between 0 and 1),
  created_at timestamptz not null default now(),
  primary key (account_id, item_id, decision_hash),
  foreign key (account_id, item_id) references inventory_item (account_id, id) on delete cascade
);

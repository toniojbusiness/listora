-- The item analysis service (plan task T-11).
--
-- An analysis is one item's photo set read by AI once per tier: `standard` first, then
-- `premium` ("Identify harder") only as an escalation of a completed standard analysis.

-- One analysis per item, photo set, and tier. The photo-set hash alone is not enough: two
-- items can carry the same photos (a duplicate listing), and an item may accept only its own
-- analysis, so each item gets its own row.
alter table ai_analysis
  drop constraint ai_analysis_account_id_photo_set_hash_tier_key,
  add constraint ai_analysis_account_id_item_id_photo_set_hash_tier_key
    unique (account_id, item_id, photo_set_hash, tier);

alter table ai_analysis
  -- The person who asked for it; usage events of its calls name them.
  add column requested_by_user_id uuid references app_user (id) on delete set null,
  -- The standard analysis a premium one escalates; set exactly for premium analyses.
  add column escalated_from_analysis_id uuid,
  -- Provider calls made for this analysis (a schema-violating answer is retried once).
  add column attempts integer not null default 0 check (attempts between 0 and 10),
  -- Whether trying again may succeed; set exactly for failed analyses.
  add column error_retryable boolean,
  add column completed_at timestamptz,
  add constraint ai_analysis_premium_iff_escalated
    check ((tier = 'premium') = (escalated_from_analysis_id is not null)),
  add constraint ai_analysis_failed_has_retryable
    check ((status = 'failed') = (error_retryable is not null)),
  add constraint ai_analysis_completed_at_iff_finished
    check ((status = 'succeeded' or status = 'failed') = (completed_at is not null)),
  add constraint ai_analysis_error_code_iff_failed
    check ((status = 'failed') = (error_code is not null)),
  add constraint ai_analysis_error_code_format check (error_code ~ '^[a-z][a-z0-9_]*$'),
  add foreign key (account_id, item_id, escalated_from_analysis_id)
    references ai_analysis (account_id, item_id, id)
    on delete cascade;

create index ai_analysis_escalated_from_idx
  on ai_analysis (account_id, escalated_from_analysis_id)
  where escalated_from_analysis_id is not null;

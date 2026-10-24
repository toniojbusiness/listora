-- Reverts 0008_item_analysis.up.sql. Premium analyses only exist as escalations, so they go
-- with the columns that describe them; restoring the account-wide uniqueness then needs at
-- most one standard analysis per photo set, so later duplicates of a set are removed too.

drop index ai_analysis_escalated_from_idx;

delete from ai_analysis where tier = 'premium';

alter table ai_analysis
  drop constraint ai_analysis_account_id_item_id_escalated_from_analysis_id_fkey,
  drop constraint ai_analysis_error_code_format,
  drop constraint ai_analysis_error_code_iff_failed,
  drop constraint ai_analysis_completed_at_iff_finished,
  drop constraint ai_analysis_failed_has_retryable,
  drop constraint ai_analysis_premium_iff_escalated,
  drop column completed_at,
  drop column error_retryable,
  drop column attempts,
  drop column escalated_from_analysis_id,
  drop column requested_by_user_id;

delete from ai_analysis newer
  using ai_analysis older
  where newer.account_id = older.account_id
    and newer.photo_set_hash = older.photo_set_hash
    and newer.tier = older.tier
    and newer.id > older.id;

alter table ai_analysis
  drop constraint ai_analysis_account_id_item_id_photo_set_hash_tier_key,
  add constraint ai_analysis_account_id_photo_set_hash_tier_key
    unique (account_id, photo_set_hash, tier);

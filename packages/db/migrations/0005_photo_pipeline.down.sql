-- Reverts 0005_photo_pipeline.up.sql.

alter table photo
  drop constraint photo_ready_has_images,
  drop constraint photo_processed_at_iff_processed,
  drop constraint photo_failure_reason_iff_failed,
  drop column processed_at,
  drop column failure_reason,
  drop column status;

drop table upload_file;
drop table upload_session;

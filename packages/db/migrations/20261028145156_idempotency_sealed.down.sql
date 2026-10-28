-- Sealed responses cannot be replayed without the column: a retry runs again.
delete from idempotency_record where response_ciphertext is not null;
alter table idempotency_record drop column response_ciphertext;

-- Stored responses are sealed (docs/architecture.md, API conventions: Idempotency).
--
-- `idempotency_record` kept each POST's response as readable JSON for 24 hours under the
-- client's Idempotency-Key, so a new invite's code (createInvite's answer) sat in the table in
-- plain text, although only its hash is kept anywhere else. A record now holds the key's SHA-256
-- in `key` and the response sealed (AES-256-GCM, under a key derived from the Idempotency-Key,
-- which only the client holds) in `response_ciphertext`, with `response_body` null. Records
-- stored before keep their form until they expire (a day at most); the API still replays them.
alter table idempotency_record add column response_ciphertext bytea;

-- Except the invites': their stored answers hold the codes. A retry of one of them (within a day
-- of its first try) creates a new invite instead of replaying the code.
delete from idempotency_record where operation_id = 'createInvite';

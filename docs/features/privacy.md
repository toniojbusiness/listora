# Privacy: deletion and retention

How Listora deletes a person's data and how long it keeps everything else (plan task T-33, red
flag RF9). Every deletion deletes the database rows at once and then finishes the rest in a
worker job that retries until done, checks that nothing is left, and writes a completion record.
A daily job deletes logs and raw payloads that expired. The threats this answers are in
[threat-model.md](threat-model.md); the user-facing drafts are the
[privacy policy](../legal/privacy-policy.md) and [terms of service](../legal/terms-of-service.md)
(drafts that need legal review before any public release).

Code: the account deletion job in `packages/accounts`, connection deletion in
`packages/connections/src/deletion.ts`, the eBay user purge in `packages/sales/src/ebay/purge.ts`,
the retention job in `packages/retention`, completion records and the row check in
`packages/db/src/deletions.ts`, and object purges in `packages/storage/src/purge.ts`.

## How every deletion works

1. **At once, in one transaction:** the rows are deleted, and a tombstone records what still
   needs outside services (an identity provider user, a marketplace grant to revoke, stored
   objects), with its job in Graphile Worker. Either all of it commits or none of it does.
2. **The job** (retries after 1 m, 5 m, 15 m, 1 h, 3 h, then every 6 h) deletes what is outside
   the database, each step committed before the next and safe to repeat:
   - stored objects are deleted and then read back; one counts as deleted only once storage no
     longer has it (`purgeObjects`);
   - a marketplace grant is revoked through the marketplace's official endpoint for up to 7
     days; after that its tokens are deleted anyway and the outcome is `manual` (the seller must
     remove Listora in the marketplace's settings).
3. **The check.** Before finishing, the job checks that no row anywhere still references what
   was deleted. For an account it reads every foreign key to `account` and `app_user` from the
   catalog (`rowsReferencing`), so a table added later is checked without a code change. While
   anything remains, the deletion stays open and logs an error; it never claims completion.
4. **The completion record.** In the transaction that deletes the tombstone, the job writes a
   `deletion_record`: kind, reason, marketplace, when it was asked for and finished, and counts
   and outcomes. It holds no account, user, or marketplace user id, no email, and no name.

**Bounded time.** A deletion finishes within 8 days (`DELETION_COMPLETION_DEADLINE_MS`: the 7-day
revocation window plus a day). One still open past that logs `account_deletion_overdue` or
`connection_deletion_overdue` on every run, and the trust metrics publish `OverdueDeletions`,
which the `deletion-overdue` alarm keys on ([observability.md](observability.md)). Deleted object
versions in S3 expire after 30 days (the photo bucket's lifecycle rule), and database backups
after their retention period (7 days for personal, 30 for production).

## What each deletion covers

| Trigger                                          | Deleted at once                                                                                                                                                                                                     | The job                                                                                                           | Kept                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Account deletion (`DELETE /v1/account`)          | The account and every row in it (photos, items, listings, sales, AI usage and analyses, operation history, connections with their tokens and sessions), and the user ([auth.md](auth.md#account-deletion))          | Deletes the identity provider user, revokes grants, deletes every stored object, checks rows and objects, records | Nothing about the person                       |
| Unlinking a marketplace (`disconnectConnection`) | The connection (tokens or browser session, the marketplace's user id and name, health), its automation runs, session checks, and sale-check schedule; its listings' read-backs; marketplace events about the seller | Revokes the grant, deletes the runs' screenshots, checks, records                                                 | Items, listings and their history, sales, fees |
| Access revoked by the marketplace                | The tokens, when the notice arrives ([connections.md](connections.md))                                                                                                                                              | 30 days later, unless reconnected, the retention job deletes the rest as an unlink (reason `revoked`)             | The same as an unlink                          |
| eBay Marketplace Account Deletion                | Every connection to that eBay user in every account (as an unlink), and every eBay event about them, in one transaction that checks and records ([ebay-notifications.md](ebay-notifications.md))                    | None needed: eBay deleted the user                                                                                | The Listora account's own records              |
| The marketplace ends Listora's access (Depop)    | Every connection to the marketplace in one mode, in every account, as an unlink (reason `marketplace_terminated`)                                                                                                   | As an unlink                                                                                                      | The same as an unlink                          |

In the app, a person deletes their account in Settings > Delete account ([auth.md](auth.md#account-deletion)) and unlinks a marketplace with Unlink in Settings > Link accounts ([marketplace-linking.md](marketplace-linking.md)).

An operator runs the last one with
`npm run admin -- marketplace-purge depop --mode api --actor <name> --reason <text>`, which only
counts the connections until it is run again with `--confirm`; the log line names the actor and
reason. The plan's privacy red flag (RF9) requires deleting Depop data when Depop ends access.

Where a grant cannot be revoked because the worker has no token vault or no OAuth client for the
marketplace, the deletion still finishes, with the revocation recorded as `manual` once the window
ends. A grant that an unlink or account deletion still holds when eBay deletes that user is
deleted by that job within its window.

## Photos carry no location

The app strips GPS before uploading, and the server never keeps a file with metadata: every
derivative (original, AI, thumbnail, listing) is a re-encoded JPEG with no EXIF, XMP, IPTC, or ICC
data, and the upload is deleted once processed ([photos.md](photos.md)). `image.test.ts` checks
each derivative's metadata, and `job.int.test.ts` checks every stored object's raw bytes: no APP1,
APP2, or APP13 segment, and none of the fixture's GPS, camera, or serial text. An upload never
attached expires from storage after 7 days.

## Retention

The daily `data_retention` job (`23 4 * * *` UTC, `runDataRetention`) deletes, in batches of 1,000
and at most 50 batches per rule a run:

| Record                                                     | Kept for                             | Notes                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Operation history (`operation_event`, redacted excerpts)   | 180 days after the operation settled | The operation keeps its final status, evidence, and error. Events that recorded a listing id the engine named stay, so no id is given twice |
| Raw marketplace notifications, poll results, parsed emails | 90 days after processing             | Unprocessed events stay. Sales keep their own row; their `inbound_event_id` is cleared                                                      |
| AI usage events                                            | 400 days                             | Daily totals (`ai_usage_daily`) stay with the account for cost reports                                                                      |
| A connection whose access the marketplace revoked          | 30 days unless reconnected           | Then deleted as an unlink                                                                                                                   |
| Connect attempts (`connection_authorization`)              | 1 day after expiry                   | Starting a new attempt also prunes the account's old ones                                                                                   |
| Deletion completion records                                | 2 years                              | No personal data                                                                                                                            |

Kept elsewhere, by the code that writes them: automation screenshots 14 days and run records
90 days (the automation dispatcher, [automation.md](automation.md)), idempotency records 24 hours,
deleted identities 48 hours ([auth.md](auth.md#account-deletion)), raw sale emails 90 days and
unattached uploads 7 days (storage lifecycle rules, [infra.md](infra.md)), and CloudWatch logs 1
week (personal), 1 month (staging), and 3 months (prod).

`operation_event` and `ai_usage_event` are append-only: a trigger rejects every direct update and
delete. The retention job may delete expired rows of one of them because it names that table in
the transaction-local setting `listora.retention_delete`; every other direct change is still
rejected, including updates, and deletes from any other table.

## Local development

Nothing needs a credential. Unlinking works against the local API, the connection deletion job
runs in the local worker (revoking on the fake eBay with `EBAY_ENV=fake`), and the retention job
runs every day at 04:23 UTC in a running worker. The tests run each job directly.

## Data

Migration `20261025221245_privacy_retention`:

- `account_deletion` gains `account_id` and `user_id` (what the job checks), `storage_prefixes`
  (`uploads/<account>/`, `photos/<account>/`, `automation/<account>/`), and `objects_deleted_at`;
  `account_deletion_object` lists the objects the deleted rows named (public derivative keys are
  unguessable, so only the rows find them).
- `connection_deletion` (the tombstone of an unlinked connection: its id, marketplace, reason, the
  grant's encrypted tokens only while its revocation is pending, the revocation outcome, attempts)
  and `connection_deletion_object` (the screenshots still to delete). Like `account_deletion`, it
  outlives the connection and its account, so it has no `account_id`.
- `deletion_record`: the completion record of every finished deletion.
- `reject_direct_change()` allows the retention job's deletes; indexes for the retention scans.

## Open items

- Apple token revocation for Sign in with Apple ([auth.md](auth.md#account-deletion)).
- Depop's own deletion requirements (its webhooks or terms may add a deletion notice like eBay's)
  once partner access is granted; the purge command covers termination today.

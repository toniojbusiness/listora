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

| Trigger                                          | Deleted at once                                                                                                                                                                                                                    | The job                                                                                                           | Kept                                                                                                                                                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account deletion (`DELETE /v1/account`)          | The account and every row in it (photos, items, listings, sales, AI usage and analyses, operation history, deleted items' records, connections with their tokens and sessions), and the user ([auth.md](auth.md#account-deletion)) | Deletes the identity provider user, revokes grants, deletes every stored object, checks rows and objects, records | Nothing about the person                                                                                                                                                                                |
| Deleting an item (`deleteItem`)                  | The item, its photos, analyses, listings, tasks, and change history ([items.md](items.md#deleting-an-item))                                                                                                                        | None: the API deletes the photos' stored objects after the delete commits                                         | The history of its marketplace actions, for the owner: the item's id, SKU, and title (`deleted_item`), its listings' (`deleted_listing`), their operations and browser sessions; never shown in the app |
| Unlinking a marketplace (`disconnectConnection`) | The connection (tokens or browser session, the marketplace's user id and name, health), its automation runs, session checks, and sale-check schedule; its listings' read-backs; marketplace events about the seller                | Revokes the grant, deletes the runs' screenshots, checks, records                                                 | Items, listings and their history, sales, fees                                                                                                                                                          |
| Access revoked by the marketplace                | The tokens, when the notice arrives ([connections.md](connections.md))                                                                                                                                                             | 30 days later, unless reconnected, the retention job deletes the rest as an unlink (reason `revoked`)             | The same as an unlink                                                                                                                                                                                   |
| eBay Marketplace Account Deletion                | Every connection to that eBay user in every account (as an unlink), and every eBay event about them, in one transaction that checks and records ([ebay-notifications.md](ebay-notifications.md))                                   | None needed: eBay deleted the user                                                                                | The Listora account's own records                                                                                                                                                                       |
| The marketplace ends Listora's access (Depop)    | Every connection to the marketplace in one mode, in every account, as an unlink (reason `marketplace_terminated`)                                                                                                                  | As an unlink                                                                                                      | The same as an unlink                                                                                                                                                                                   |

Two records of a marketplace seller's handle outlive a connection on purpose
([read-only.md](read-only.md#the-shop-not-the-row)). The sellers an account kept read only
(`read_only_seller`) stay through an unlink, as the Read only setting does, and go with the
account. A protected shop (`protected_seller`) belongs to no account: its seller id stays when an
account that linked it is deleted, because keeping that shop safe is its only use, and only a
migration removes it.

In the app, a person deletes their account in Settings > Delete account ([auth.md](auth.md#account-deletion)) and unlinks a marketplace with Unlink in Settings > Link accounts ([marketplace-linking.md](marketplace-linking.md)).

The marketplaces that run on the seller's iPhone ([phone-execution.md](phone-execution.md)) add
two things. An unlink also deletes the connection's work waiting for the phone (`phone_work`), and
an account deletion deletes the account's devices (`app_device`: name, app version, push token).
The sign-in the phone keeps in its Keychain is removed by the app when the seller unlinks the
marketplace or deletes the account there, and when another Listora account signs in on the
phone.

### Unlinking while work runs

An unlink can come while work on the connection is in flight: the phone answering a sale check,
an import page, a session check. The unlink locks the connection's row and then deletes the rows
of its work, so work that holds one of those rows must never then wait for the connection (every
insert that references the connection does): the two would deadlock, and Postgres would fail one
of them. So a transaction that writes a connection's rows locks the connection first
(`lockConnections` in `@listora/db`, `for key share`, which blocks only deleting the
connection) before any of them: the phone's claim (the connections its device runs) and its
answer (the run's connection), the engine's claim of a step, a sale check asked for by an email
or a sync, an offer check or answer, an import's pages, entries, and answers, and the sale an
order check hands over. The unlink then waits for the work to commit, or the work for the
unlink, after which it finds the connection gone and stops. Should work that breaks the order
still meet an unlink, Postgres rolls one of them back; when that is the unlink, it runs again
(up to three times, each logged as a warning naming the deadlock), so an unlink always completes.

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

Pack check's package photos ([pack-check.md](pack-check.md#package-photo)) go the same way: the app
re-encodes them, the server keeps only its own re-encoded `listing` image and deletes the upload.
They show the buyer's address on the label, so they are private objects the app reads only
through hour-long signed URLs, never cached, and they are deleted with the account (their keys
are in the deletion's objects), when the seller removes one, when an order is unpacked, and 60
days after the sale shipped (the worker's hourly `pack_photos` job). Pack check keeps a buyer's
first name only, never their full name or address.

## Retention

The daily `data_retention` job (`23 4 * * *` UTC, `runDataRetention`) deletes or clears, in batches
of 1,000 and at most 50 batches per rule a run:

| Record                                                             | Kept for                             | Notes                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operation history (`operation_event`, redacted excerpts)           | 180 days after the operation settled | The operation keeps its final status, evidence, and error. Events that recorded a listing id the engine named stay, so no id is given twice                                                             |
| Raw marketplace notifications, poll results, parsed emails         | 90 days after processing             | Unprocessed events stay. Sales keep their own row; their `inbound_event_id` is cleared                                                                                                                  |
| Sale-check records (`sale_check_run`, what each check read)        | 90 days after the check              | The schedule keeps the health; a sale keeps its detection source, and its `sale_check_run_id` is cleared ([activity.md](activity.md))                                                                   |
| AI usage events                                                    | 400 days                             | Daily totals (`ai_usage_daily`) stay with the account for cost reports                                                                                                                                  |
| A connection whose access the marketplace revoked                  | 30 days unless reconnected           | Then deleted as an unlink                                                                                                                                                                               |
| Connect attempts (`connection_authorization`)                      | 1 day after expiry                   | Starting a new attempt also prunes the account's old ones                                                                                                                                               |
| Deletion completion records                                        | 2 years                              | No personal data                                                                                                                                                                                        |
| A sale label's buyer first name and tracking number (`sale_label`) | 60 days after the sale is done       | Done: shipped, canceled, or returned, from the latest of those, so a return starts the count again. Cleared, with the label's carrier and source; the sale stays. A sale that never got done keeps them |
| A package's tracking number (`sale_pack`)                          | 60 days after the sale is done       | Cleared; the package record stays (packed when, how it matched), its activity entry reads "Packed", and Pack check no longer shows the order ([pack-check.md](pack-check.md))                           |
| The buyer's name on an offer (`marketplace_offer`)                 | 60 days after the offer closed       | Cleared; the offer, its amounts, and the seller's answers stay ([offers.md](offers.md))                                                                                                                 |

The three buyer rows (the last three) run only with `BUYER_DATA_RETENTION=on` (worker,
`.env.example`). Clearing them is permanent, so the setting is `off` by default and in every
deployment (`infra/src/containers.ts`) until the owner turns it on; while it is off, each run
clears nothing of buyers and logs how many rows each of the three would clear
(`buyer data retention is off`, `wouldClear`), so the owner can see what turning it on will do.

Kept elsewhere, by the code that writes them: automation screenshots 14 days and run records
90 days (the automation dispatcher, [automation.md](automation.md)), package photos 60 days after
the sale shipped, like the buyer's other details ([pack-check.md](pack-check.md#package-photo)),
idempotency records 24 hours (their
responses sealed under the client's Idempotency-Key), deleted identities 48 hours
([auth.md](auth.md#account-deletion)), raw sale emails that could not be processed 14 days and
unattached uploads 7 days (storage lifecycle rules, [infra.md](infra.md)), and CloudWatch logs 1
week (personal), 1 month (staging), and 3 months (prod). The database logs slow statements
without their bind parameters, so no person's values reach those logs.

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
- `sale_pack.tracking_number` may be empty: with buyer data retention on, the retention job
  clears it with the label's buyer
  details (migration `20261029080126_buyer_data_retention`, audit L4).

## Open items

- Apple token revocation for Sign in with Apple ([auth.md](auth.md#account-deletion)).
- Depop's own deletion requirements (its webhooks or terms may add a deletion notice like eBay's)
  once partner access is granted; the purge command covers termination today.

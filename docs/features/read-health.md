# Background read health: the owner hears when a read keeps failing

Listora reads each automation connection in the background: its sale checks, its listing imports,
and its offer checks. When one of those reads fails again and again, the owner gets an email that
names the marketplace, the read, the step it stopped at, and its last error, and an admin view
lists when each read last worked. The seller sees none of it: a working connection whose reads
fail is Listora's to fix, not theirs (customers see only what they can act on).

Code: `packages/automation/src/read-health/health.ts` (recording, the thresholds, the email, the
alert task), the hooks in `sale-checks/job.ts`, `imports/read.ts`, and `offers/record.ts`, the
worker's `read-alerts.ts`, the admin CLI's `read-health.ts`, and the owner alert configuration in
`packages/alerts/src/owner.ts`.

## How it works

- **Every read records its outcome.** A scheduled sale check, an import page, and an offer check
  each record that they worked (`recordReadSucceeded`) or failed (`recordReadFailed`), with the
  failure's code, the script step it stopped at, and the script's own sanitized words for why
  (`AutomationReadError.detail`: what the script expected, never page text or anything typed). A
  read Listora's own pacing put off (`automation_paced`, `automation_busy`) is not a failure. A
  history read (`sale-history read`) is an operator's one-off and is not counted.
- **Thresholds.** A read is a problem when it failed `READ_ALERT_FAILURES` (3) times in a row, or
  failed and has not worked for `READ_ALERT_NO_SUCCESS_HOURS` (24) hours (since its first
  failure, for a read that never worked). A read that works ends the run of failures.
- **One email per run of failures.** The worker's `background_read_alerts` task (every 5 minutes)
  emails the owner about each problem of a working automation connection (`connected` or
  `degraded`) not emailed yet. It sets `owner_alerted_at` and sends in one transaction, so a send
  that fails is retried by the next round and never marked sent. A connection only the seller can
  fix (`reauth_required`, `revoked`) has its own reconnect card and the
  `connection-needs-relink` alarm instead.
- **Delivery.** In AWS the worker sends through SES (`OWNER_ALERTS=ses`), from the alert sender
  to the alarm email, the same addresses as the alarm emails ([alerts.md](alerts.md)); its task
  role may send only from that sender. In development and tests the email is only logged
  (`event: "owner_alert_email"`). Each alert also logs `event: "read_alert"`, and a failed send
  `event: "read_alert_failed"`.

## The words: only what the reader knows

An alert never says a marketplace's page changed. A page without what the reader expected
(`element_missing`) does not prove a layout change: Mercari's iPhone layout drew placeholder rows
while its rows loaded, and Depop's sold page listed receipts the reader did not handle, and both
failed this way on pages that had not changed. So the email gives the code, what it means as far
as the reader knows (`readFailureReason`), and the reader's own words, for example:

```text
Subject: [Listora personal] Mercari sale check failed 7 times in a row

Marketplace: Mercari
Read: sale check
Step: read the in progress sales
Last error: element_missing
What it means: The page did not have what Listora's reader expected. This does not prove the page
  changed: a page still loading its rows, or a page shape the reader does not handle, fails the
  same way.
Reader's words: Mercari's in progress tab has rows that link to no listing.
Failed in a row: 7, since 2026-10-27T10:00:00.000Z
Last worked: 2026-10-27T06:00:00.000Z (30 hours ago)
```

The seller's own words for these failures (the sale check's, the import's, the offer check's,
and the activity timeline's) no longer say the page changed either.

## What to do with an alert

1. `npm run admin -- read-health --account <account-id>` (in AWS,
   `scripts/admin-remote.sh <env> -- read-health --account <account-id>`): every read of every
   automation connection, when each last worked, its run of failures, the last error's code, step,
   and words, and when the owner was emailed. `--marketplace` narrows it, `--json` prints it all.
2. For a sale check, `sale-checks` lists the checks themselves and `sale-history read` proves the
   reader on the seller's real sold history, read-only ([activity.md](activity.md)).
3. The step and the reader's words say where the script stopped; the log line of the run
   (`runId`) has the page's structure-only evidence ([automation.md](automation.md)).

## Local development

Nothing to configure: `OWNER_ALERTS` defaults to `log`. The thresholds and the delivery keys are
in `.env.example`. `read-health/health.test.ts` covers the thresholds and the email's text,
`read-health.int.test.ts` the offer and import hooks and the alert task on real Postgres, and
`sale-checks.int.test.ts` a sale check failing three times on the fake site through the runner.

## Data

Migration `20261028175148_background_read_health`: `background_read_health`, one row per
connection and read (`sale_check`, `listing_import`, `offer_check`): `last_succeeded_at`,
`last_failed_at`, `failures_in_a_row`, `failing_since` (the run's first failure, null while the
read works), `last_error_code`, `last_error_step`, `last_error_detail`, and `owner_alerted_at`.
Deleted with its connection or account.

## Follow-ups

- Pack check's label reads and the session checks are not counted yet.
- A "Recovered" email when a read that was emailed about works again.
- Sale checks that never run (`overdue`) still reach the owner only through the
  `sale-checks-unhealthy` alarm, whose email does not name the connection.

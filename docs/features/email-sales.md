# Email sale detection

Plan task T-23. Poshmark, Mercari, and Depop tell a seller about a sale by email. The seller
forwards those emails to a private Listora address, and Listora records the sale and delists
the item everywhere else within about a minute, instead of waiting for the next scheduled sale
check ([automation.md](automation.md)). A spoofed email never delists anything, and an email
Listora cannot read or match becomes a task for the seller, never a delist. Code:
`packages/email-sales` (everything below), the worker's `email-sales.ts` feature,
`apps/api/src/sale-emails` (the address, the setting, the dev drop endpoint),
`apps/api/src/tasks/sale-email-tasks.ts` (finishing the tasks), the email stack in `infra/`,
and the iPhone's sale emails section (`MarketplaceLinkingFeature`) and task screens
(`TasksFeature`).

## The address

Each account gets one forwarding address, `sales+<token>@<inbound domain>`, the first time the
app asks for it (`getSaleEmails`). The token is 20 random base32 characters (100 bits), so an
address cannot be guessed, and mail reaches an account only through its own token: a message
to any other address is dropped. The inbound domain is `in.<domain>` in AWS and
`in.listora.test` in development (`EMAIL_INBOUND_DOMAIN`).

**Settings > Link accounts > Sale emails** shows the address with one-tap copy, the server's
setup steps (Gmail: add the address under Forwarding and POP/IMAP, then a filter that forwards
the marketplaces' sold emails, `from:(poshmark.com OR mercari.com OR depop.com) subject:(sold OR
sale)`), the status, and the "Ask before delisting" switch. The status is the server's:

| Status        | When                                                |
| ------------- | --------------------------------------------------- |
| `unavailable` | This deployment receives no email (no domain yet)   |
| `not_set_up`  | Nothing has arrived yet                             |
| `confirming`  | The email provider sent its forwarding confirmation |
| `working`     | A marketplace email passed the sender checks below  |

**Forwarding confirmation.** Gmail (and some other providers) confirm a new forwarding address
by sending a code and a link to it, which is Listora's address. Listora reads that email (only
when its sender checks pass, from a known provider: Gmail, Yahoo, Outlook, iCloud, AOL, Proton,
Fastmail), keeps the code and the link (only a link on the provider's own domain), and the app
shows them until forwarding works: the seller types the code into Gmail or taps to open the
link. Listora never opens it itself. The connection health summary (`getConnectionHealth`) shows
the same status in its sale forwarding row.

## Ingest: two drivers behind one interface

`MailSource` (`drivers/source.ts`) hands the worker's `email_ingest` job (every minute) each
waiting message; the job processes it and only then deletes the raw message, so a message whose
processing failed (the database was down) is read again.

- **`folder`** (development and tests, `EMAIL_INGEST=folder`): every `.eml` file in
  `EMAIL_INBOX_DIR` (`.local/inbox`) is a message, read in name order and deleted once
  processed. The API's `POST /dev/email` (only with this driver) drops a posted
  `message/rfc822` body there. A dropped file plays the receiving server's part itself: its
  first `Authentication-Results` header from `mx.listora.test` carries the SPF and DKIM
  verdicts, and its `Delivered-To` header the forwarding address. A file without them is
  rejected like a spoofed email.
- **`ses`** (AWS, `EMAIL_INGEST=ses`): SES receives mail for `in.<domain>`, scans it for spam
  and viruses, stores the raw message in the inbound mail bucket under `inbound/`, and publishes
  its notification (the stored object's key and the SPF, DKIM, spam, and virus verdicts) to an
  SNS topic that delivers it, raw, to an SQS queue. The worker reads the queue with a 1-second
  long poll, fetches the object, and deletes the object and then the queue message. A message
  that keeps failing moves to a dead-letter queue after 5 receives; the bucket's lifecycle rule
  removes any raw message left after 14 days. `EMAIL_INGEST=off` reads nothing and shows no
  address (an AWS environment without a domain).

## Processing one email

`processInboundEmail` (`process.ts`), in one transaction per email:

1. **Whose is it?** The forwarding address it was delivered to (SES's envelope recipients, or
   the file's `Delivered-To`) names the account.
2. **Who sent it?** The From address's domain: a marketplace (`poshmark.com`, `mercari.com`,
   `depop.com`, or a subdomain; never a look-alike), an email provider, or anyone else (dropped).
3. **Is it true?** (`authentication.ts`, plan red flag RF8.) SPF must pass for the server that
   handed the mail over (the seller's provider, which rewrites the envelope sender when it
   forwards), and a DKIM signature of the sender's own domain must pass, aligned with the From
   address. Automatic forwarding keeps the marketplace's signature intact; a message signed only
   by the forwarder, by a look-alike, or by nobody fails. In AWS the verdicts are SES's
   (`spfVerdict`, `dkimVerdict`, and the signing domain from the `Authentication-Results` header
   SES adds on top of the stored message); in development the dropped file's first header. Only
   the receiver's own header counts, because a sender can put any header lower in its message.
   A marketplace email that fails is stored as a rejected `inbound_event` (`signature_ok` false,
   result `failed`, "Rejected: ..."), logged as a warning, and nothing else happens: no sale, no
   task, no sale check.
4. **What does it say?** The marketplace's deterministic parser (`parsers/`): a sold notice
   (its subject) with the item's title, price, order number, and a link to the listing
   (`parseListingUrl`), plus Listora's SKU anywhere in the text. Not a sold notice (an offer, a
   like): ignored, though it proves forwarding works. A sold notice without a price, or without
   anything to match it by: an unknown format.
5. **Which item?** (`match.ts`) By the marketplace's listing id (verified or pending), then the
   SKU, then, as a last resort, the title of the items listed on that marketplace (ignoring case,
   spacing, and punctuation; a title the email cut short with `...` matches by its start).
   Exactly one item is a match.
6. **What happens:**

   | Case                               | Result                                                                                 |
   | ---------------------------------- | -------------------------------------------------------------------------------------- |
   | Matched                            | `recordSale` (detection `email`): the sale, its estimated fees, and its auto-delist    |
   | Matched, "Ask before delisting" on | An urgent `confirm_sale` task; confirming records the sale, dismissing records nothing |
   | Matched, already recorded          | Nothing (the event is `ignored`)                                                       |
   | Several items match                | An urgent `review_match` task with the candidates, and a sale check at once            |
   | Unknown format                     | An urgent `review_match` task without candidates, and a sale check at once             |
   | No Listora listing matches         | Ignored, and a sale check at once                                                      |

   Each task is pushed to the seller's phone ("Sold on Poshmark?"). A sale check
   (`requestSaleCheck`, [automation.md](automation.md)) reads the marketplace itself when the
   email could not be acted on; the next check after it is scheduled from the seller's history
   as always, and email sales count in that history.

Each email is stored once (`inbound_event`, source `email`, keyed by a hash of its Message-ID),
so an email forwarded twice is a duplicate.

## Deduplication with the scheduled checks

A sale email names the order by the marketplace's order number, which the automated sale check
(reading the listing) may not show, so the two cannot meet on the order id. A listing sells
once, so `recordSale` treats a sale of an item that already has a standing sale on the same
marketplace as the same order when either report came from an email: whichever arrives first
records the sale, and the other is a duplicate, never a double-sale incident. It locks the
items first, so an email and a check reporting at once record one sale.

## The tasks

Both tasks hold what the email said (`UserTask.saleEmail`): the reason, the title, price, sold
time, and order number it gave, a short excerpt, and for an ambiguous match the candidate items.
The app shows the email's details and:

- **`confirm_sale`**: "Confirm - it sold" (`completeTask`, optionally with `saleCorrection`)
  records the sale and starts its auto-delist; "Dismiss task" records nothing.
- **`review_match`**: "This one" on a candidate (`matchedItemId`; or `matchedListingId`) records
  that item's sale; "None of these sold" (`rejectMatch`) records nothing. Without a parsed price
  the sale takes the item's listing price on that marketplace, or the request is `422`.

A sale recorded meanwhile (by a check or another email) is not recorded twice; the task then
points at that sale (`saleId`).

## What is kept

The raw message is deleted once processed. The `inbound_event` keeps the parsed fields and an
excerpt of at most 280 characters (`redact.ts`): the start of the text with email addresses,
links, `@` user names, numbers of 7 digits or more, and the lines that name a buyer or a
shipping address removed. Logs name the account, the marketplace, and the outcome, never the
message.

## Local development

`EMAIL_INGEST=folder` is the default. Ask the API for your address (`GET /v1/sale-emails`, or
open Link accounts), then post a message with the receiver's headers on top:

```sh
curl -X POST http://127.0.0.1:3000/dev/email -H 'content-type: message/rfc822' --data-binary @- <<'EOF'
Delivered-To: sales+<token>@in.listora.test
Authentication-Results: mx.listora.test; spf=pass smtp.mailfrom=gmail.com; dkim=pass header.d=poshmark.com
From: Poshmark <orders@poshmark.com>
Subject: You made a sale on Poshmark!
Message-ID: <any-unique-id@poshmark.com>

Item: <the listing's title>
Price: $45.00
Order ID: 123
EOF
```

The worker reads it within a minute. The synthetic fixtures in
`packages/email-sales/fixtures/` are examples of each template.

| Switch                                                        | Effect                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------ |
| `EMAIL_INGEST`                                                | `folder` (default), `ses`, or `off`                    |
| `EMAIL_INBOUND_DOMAIN`                                        | The forwarding addresses' domain (`ses` requires it)   |
| `EMAIL_INBOX_DIR`                                             | The folder driver's directory (default `.local/inbox`) |
| `EMAIL_SES_QUEUE_URL`, `EMAIL_SES_BUCKET`, `EMAIL_SES_REGION` | The SES driver's queue, bucket, and region             |

## In AWS

The email stack ([infra/README.md](../../infra/README.md)) holds the inbound mail bucket in
every environment. With a domain it adds the SES domain identity (Easy DKIM), the MX record for
`in.<domain>`, the receipt rule set (scan, TLS required, store under `inbound/`, notify the
topic), the topic (only SES of the account may publish), and the encrypted queue with its
dead-letter queue; the containers then run with `EMAIL_INGEST=ses`, and the worker's role may
read and delete `inbound/*` and consume the queue. Without a domain (the personal environment
today) there is no rule, topic, or queue and the containers run with `EMAIL_INGEST=off`: sales
are found by the scheduled checks alone. SES allows one active receipt rule set per account and
region and CloudFormation cannot activate one, so after the first deploy with a domain an
operator runs it once:

```sh
aws ses set-active-receipt-rule-set --rule-set-name listora-<env>
```

Cost: SES receiving is $0.10 per 1,000 emails; the SNS delivery to SQS is free, and the
worker's once-a-minute poll is about 45,000 SQS requests a month, inside the free tier
([costs.md](costs.md)).

## Data

Migration `20261025221236_sale_emails`:

- `sale_email_inbox`, one per account: the address token, `ask_before_delist` (default off),
  when the latest email, verified marketplace email, and sale email arrived, and the provider's
  forwarding confirmation (provider, code, link, time).
- `user_task_sale_email_key`: one confirm or review task per sale email.

A sale email is an `inbound_event` (source `email`, [operations.md](operations.md#data)), and
its sale has `detection_source` `email`.

## Open items

- The parsers and sender domains follow synthetic fixtures. Check them against real Poshmark,
  Mercari, and Depop sold emails (subjects, labels, links, click-tracking redirects that hide
  the listing link, sending domains) and add those samples as fixtures.
- An unknown-format review lists no candidates; the app asks the seller to mark the item sold
  from its screen. An item picker in the task would finish it in one place.
- Depop webhooks (once its API is granted) use Depop's order ids; their sale and an email's are
  deduplicated by the item rule above, which assumes one of each item.

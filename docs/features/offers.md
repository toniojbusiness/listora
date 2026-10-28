# Offers

Buyers' offers on the seller's listings, in one place: Listora reads the offers waiting on the
seller from each marketplace, read-only, in the seller's own session, and shows each in Tasks with
the item, the amount, the buyer's details, what accepting gives after the marketplace's fees, when
it expires, and Open in Poshmark. The seller can accept, decline, or counter it from Listora. An
answer is sent only for the seller's tap on a confirmation that shows the amount and the net
after fees, never on its own, and it is shown as done only once a read of the offer on the
marketplace shows it.

Poshmark and Depop are read and answered. Mercari is not yet: its website showed the captain's
session no page of the offers buyers make (below).

| Where                                                    | What                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/marketplaces/src/offers.ts`                    | `RemoteOffer`, the answer's request and outcome, each marketplace's rules |
| `packages/automation/src/<marketplace>/pages/offers*.ts` | Where each marketplace's pages carry the offers                           |
| `packages/automation/src/adapter/offer-fields.ts`        | An offer's record read by field names                                     |
| `packages/automation/src/adapter/offer-page.ts`          | Reading an offer's page, and answering on it                              |
| `packages/automation/src/offers/`                        | Asking for reads, recording them, and the answer's rules                  |
| `packages/automation/src/fake-offers/`                   | The fake sites' offers and offer page, and the shared offers test suite   |
| `apps/api/src/offers/`                                   | The offer endpoints; the tasks' views show offers (`apps/api/src/tasks`)  |
| `TasksFeature` (iOS): `OfferModel`, `OfferTaskView`      | The offer on the task screen, its answers and confirmations               |

## Reading the offers

- **Where.** Poshmark and Depop run on the seller's iPhone (`cloudAllowed` is false for both,
  [phone-execution.md](phone-execution.md)), so a read waits in `phone_work` (purpose
  `offer_check`, one per connection, behind routine changes and sale checks) and runs at the
  phone's pace, within the per-seller rate limits, like every run. A connection whose steps run
  in the cloud is not read.
- **When.** Only when the seller asks, never on a timer: when they open Tasks or pull to refresh
  (`requestOfferChecks`, at most once every 10 minutes per marketplace), and when they sync
  (opening the app, Sync now, a pull to refresh on Today or Sales, at most once every 2 minutes,
  [sync.md](sync.md)). Live reads on the Mac
  (recordings, below) go through the machine-wide pace (`market-pace.sh`).
- **What each marketplace's pages show** (read on the captain's sessions, 2026-10-27, which had
  no offer, so an offer's own record is read by field names that say what each value is, and a
  record naming no offer id, amount, or whose turn it is stops the read as a page Listora doesn't
  know; an offer is never guessed):
  - **Poshmark**: Active Offers (`/offers/my_offers`) fills its data after load from
    `/vm-rest/users/<id>/offers/feed`: `$_order_activity.orderActivity.activeOffers`, a
    `sale_offer_summaries` story for the offers on the seller's listings, an `info_message` when
    there are none. The read waits for the page's `active-offer-section`.
  - **Depop** (read on a real shop's session and in Depop's own scripts, 2026-10-28): the
    products with offers, `GET /presentation/api/v1/offers/me/products/?after=<page_info.last>`
    (`cursor=` is ignored; `objects`, each named by `product_id` with its price, but no slug, so
    the seller's listings for sale name each product's listing), then each product's offers,
    `GET /presentation/api/v1/products/<id>/offers/?active=true&include_size=true&variant_id=<v>`
    (the product, with its offers under `offers`, not `objects`, and a `page_info` that may have
    only `has_more`), each with `offer_id`, `offer_value` (a string), `offer_display_status`,
    `expires_at`, `can_make_counter_offer`, and `offerer_username`. The Offers page counts the seller's
    own offers too: on that shop 38 of its 39 active offers were `SENT_PRIVATE_OFFER` (offers she
    sent to likers) and one `ACCEPTED`, with no buyer offer waiting (the hub's
    `seller_offers_to_review: 0`). Only a status ending in `RECEIVED` waits on the seller; the
    seller's sent offers and accepted, declined, expired, and sold ones are never tasks, and a
    status Listora doesn't know stops the read rather than guess. Depop's offers name no listing
    price, so the listing's own price (as Listora last confirmed it) bounds a counteroffer, and
    an offer's Open in Depop is the selling hub's Offers page. Listora's id of a Depop offer is
    `<product id>/<variant id>/<offer id>`, so its read-back asks that product's offers.
- **What a read records** (`offers/record.ts`): each offer waiting on the seller is a
  `marketplace_offer` (`pending`) with the Listora listing and item it is for, and has one open
  `answer_offer` task. An offer Listora had as pending that a read no longer shows waiting on the
  seller is `closed` (it expired, the buyer withdrew it or bought the listing, or the seller
  answered it in the marketplace's app), and its task closes; an answer from Listora under way
  decides its own offer instead. An accepted or declined offer is final; a countered one waits
  on the buyer, and comes back as pending when the buyer counters with another price. A read that
  failed changes no offer, and the connection's `offer_check` says when the offers were last read
  and why the newest read failed (Tasks shows it).

## Answering one

1. **Asking** (`requestOfferAnswer`, `POST /v1/offers/{offerId}/responses` with an
   Idempotency-Key): only while the offer waits on the seller and has no answer under way, at the
   amount the seller's confirmation showed (an offer the buyer changed since is refused), a
   counter only above the offer and below the listing's price, and only on a working automation
   connection that runs on the phone. It records an `offer_response` with what the confirmation
   showed (the amount, the counter, the net after fees) and hands it to the phone
   (`offer_response` work). The same key returns the same answer.
2. **Sending** (`offers/answer.ts`, run by the phone, `phone/work.ts`): one step on the offer's
   page (`adapter/offer-page.ts`): open it and check the amount, enter a counter's price, then
   the one step that changes something, the answer's button and the marketplace's confirmation.
   From the moment the phone may send it (`sent`), the answer is never sent again, even when the
   run stops before the phone's reply: a later run only reads the offer back.
3. **Done only by read-back.** The same run then reads the offer's page; the answer is
   `succeeded` (`success_evidence = 'read_back'`) only when that read shows it (accepted,
   declined, or countered at the seller's price). A read that doesn't show it yet is read again
   30 seconds later, up to six steps in all; then the answer fails, asking the seller to check the
   offer on the marketplace, never claiming either way. The marketplace refusing it (the offer
   moved on, a counter out of range), the offer gone, or the offer answered otherwise fails it
   with the reason; a check automation must not pass, or a page Listora no longer reads, fails it
   and the seller answers in the marketplace's app. A send that surely changed nothing (pacing, a
   page that failed before the answer) is sent again a minute later, at most three times.
4. **A read-only account** ([read-only.md](read-only.md)) is read like any other, but its offers
   show no answers: asking for one is refused, and an answer asked for before the account became
   read only fails at the phone's claim, before anything is sent.
5. **An accepted offer** closes its task and asks for a sale check of the marketplace at once
   (reason `offer`), so the sale goes through the normal sale flow from the marketplace's own sold
   orders ([auto-delist.md](auto-delist.md)): on Poshmark at once (the buyer paid when they
   offered), on Depop when the buyer checks out.

The invariant test (`packages/operations/src/invariant.test.ts`) checks that an answer's evidence
is set in one place, right after a read-back that shows it.

An app installed before offers (phone runtime version 2) keeps running every other marketplace
step; offer reads and answers wait until it runs version 3, which it takes from the server
between runs ([phone-execution.md](phone-execution.md)).

## In the app

- **Tasks** asks for a read of the offers when it opens and on pull to refresh, runs the
  phone's work at once, and shows a banner for a marketplace whose offers could not be read. An
  offer's task reads "$30.00 offer on Depop".
- **The offer's screen** (`OfferTaskView`): the offer on a price tag (the amount, the listing's
  price, the listing, the buyer, a bundle's size, shipping, and when it expires), what accepting
  gives after fees and what accepting does there, Open in Depop, and Accept, Counter (the price,
  checked against the offer and the listing's price, with its net from `getOfferQuote`), and
  Decline. Each opens a confirmation with the amount and the net after fees; only its button
  sends. The answer then shows in the server's words ("Accepting on your iPhone...", "Accepted
  (confirmed by Depop)", or why it failed), read every 2 seconds while it runs. A task has no
  Done; Hide this offer dismisses its task until the buyer changes the offer, and the offer stays
  open on the marketplace.

## Local development and tests

Nothing to configure. The fake Poshmark and Depop sites hold offers (`site.offers`,
`FakeOfferDesk`) in their marketplace's data, an offer page every fake shares (amount, status,
Accept, Decline, Counter, the confirmation), and faults (a refusal, an answer taken whose page
then failed, a server error). Accept, decline, and counter are only ever tested on the fakes and
recorded pages, never on a real buyer's offer.

- `fake-offers/offers-suite.ts`, run by `poshmark/offers.int.test.ts` and
  `depop/offers.int.test.ts` in a real headless Chromium: the read, accept, decline, counter,
  refusals, an offer that moved or went away, a lost answer reported as unknown, a bot check that
  stops the read, and a page Listora no longer reads.
- `phone/work.int.test.ts`, through the phone runtime: a read on the phone making tasks and
  closing them, an accept done only on read-back and the sale check it asks for, a lost answer
  read back and never sent again, an answer the phone stopped in the middle of treated as maybe
  sent, and refusals.
- `apps/api/src/offers/offers.int.test.ts`: the task with its offer, net, and answers; one answer
  per key; refusals; the quote; another account's offers; the read requests and their gap.
- `OfferModelTests` (iOS): nothing sent before the confirmation, one send, the key reused for a
  lost reply, the counter's range and net, following the answer to its read-back, the inbox's
  read request.
- Recordings ([recorded-pages.md](recorded-pages.md)): the `offers` entry of Depop's plan, read
  in the seller's own Chrome. Poshmark's plan has none yet: its Active Offers kept the offers list
  loading in the recorder's background tab (2026-10-27), so its read stopped there, as a page
  Listora doesn't know, as it must.

## Data

Migration `20261028083845_marketplace_offers`:

- `marketplace_offer`: an offer as the marketplace last showed it (`pending`, `accepted`,
  `declined`, `countered`, `closed`), its listing and item when Listora has the listing, the
  amount, the listing's price, the buyer's public username (nothing more of them), details
  (bundle size, shipping), its page, when it was made and expires, and when it was first and last
  seen. Deleted with its connection or account.
- `offer_response`: the seller's answer, one per tap (its Idempotency-Key, one under way per
  offer): the action, what the confirmation showed, its status (`queued`, `running`, `verifying`,
  `succeeded`, `failed`), whether it may have been sent, its attempts, and its evidence (a
  succeeded answer has `read_back`) or error.
- `offer_check`: when each connection's offers were last asked for and read, and how that went.
- `user_task` gains the kind `answer_offer` and its `offer_id` (one open task per offer);
  `phone_work` gains `offer_check` and `offer_response` (with its `offer_response_id`);
  `automation_run.purpose` gains `offer_check` and `offer_response`; sale checks gain the reason
  `offer`.

## Open items

- **Mercari.** Its website showed the captain's session no page of the offers buyers make
  (`/mypage/offers/`, `/mypage/notifications/`, and `/us/notifications/` are 404, and My Page and
  the seller dashboard link none); its sellers answer offers in its app. Read them once a session
  shows where (the header's notifications, `dropdownHeaderQuery`, are a lead).
- The offer pages' selectors (Accept, Decline, Counter, the confirmation) are the fake sites'
  until a session shows a real offer; a real page without them stops the answer as a page Listora
  no longer reads, and the seller answers in the marketplace's app.
- A Poshmark recording of Active Offers, from a foreground tab or a later session.
- Depop's hub counter (`users/<id>/counters`, `seller_offers_to_review`) could skip the
  per-product reads when no buyer offer waits; the scripts don't know the seller's user id yet.
- A connection that runs in the cloud: no marketplace with offers may run there today.

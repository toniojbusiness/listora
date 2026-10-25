# Today

The app's home: the first tab tells the seller exactly what needs them today, most urgent first,
each card with one action that opens the right screen, and how this week's sales compare with last
week's. Once a day, at the seller's chosen time, a morning summary notification says the same.
The rules and queries are `@listora/today` (`packages/today`); the endpoint is
`apps/api/src/today`, the notification job `apps/worker/src/features/today-summary.ts`, and the
screen the `TodayFeature` package (`apps/ios/Packages/Features/Sources/TodayFeature`).

## How it works

`getToday` (`GET /v1/today`) computes the summary on every request from the tables that already
hold the truth: a few plain, indexed queries per account (`loadToday` in `summary.ts`), turned
into cards by pure rules (`cards.ts`). It calls no AI and no marketplace, so the app asks for it
each time the screen appears. There is no stored card state: a card exists only while its work is
not done, so it is gone from the next summary once the work is finished.

| Card            | Shown for                                                                                                                                                   | Urgency                                                                                      | Action                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------- |
| `delist`        | A delist run that is not done everywhere, from its computed per-marketplace truth ([auto-delist.md](auto-delist.md)); not for a canceled or returned sale   | `urgent` while it waits for the seller (`attention_needed`), `high` while Listora delists    | The item screen           |
| `ship`          | An item sold in a sale not yet shipped (`detected`, `confirmed`) whose item is `sold` or `sold_pending_delist`; Mark shipped on the sale screen finishes it | `urgent` with the ship-by date a day away or past, `high` within 3 days (or undated after 2) | The sale screen           |
| `reconnect`     | A connection only the seller can fix: `reauth_required` or `revoked` ([connections.md](connections.md))                                                     | `high`                                                                                       | The marketplaces screen   |
| `review_drafts` | Items in `draft`, as one card with the count                                                                                                                | `normal`                                                                                     | The drafts (Add Item tab) |
| `stale_listing` | A `listed` item whose oldest live listing went live 30 or more days ago, with no listing change (create, revise, price, relist) in 14 days; 5 at most       | `normal`                                                                                     | The item screen           |

- **Order.** Most urgent first; within one urgency by kind in the order of the table; within one
  kind, soonest ship-by, oldest delist, and longest listed first.
- **Price drop, never below the floor.** A stale listing suggests 10% off its price (the item's
  list price, else its lowest live listing price), rounded down to whole dollars and raised to the
  item's floor (`staleSuggestion`). When that is no drop at all (the price is at its floor), or the
  item has no floor, it suggests a relist instead: Listora never suggests a price it cannot check
  against the floor. The action only opens the item; the seller changes the price there, through
  the operation engine.
- **Words.** Titles, details, and action labels are the server's, so the app and the morning
  summary say the same; the app adds dates in the device's calendar ("Ship by tomorrow", "Overdue
  since Oct 24") and shows a delist's `statusDisplay` as its honest status badge.
- **Money.** The last 7 days (`thisWeek`, ending now) next to the 7 days before (`lastWeek`), so a
  Monday morning compares two whole weeks. Canceled and returned sales count for nothing; shipped
  ones count. A sale's profit is the Sales tab's, computed by the same `saleMoney`
  ([sales.md](sales.md)), so the two never differ; it is unknown until the sale has fee lines and
  every item a cost. An unknown profit is never
  guessed: it is left out of `profit` and counted in `profitPendingSales`, and `profit` is absent
  when no sale's profit is known.

### The screen

The Today tab is the first of the five tabs (Today, Inventory, Add in the center, Tasks, Sales)
and the one the app opens on; its header has the morning summary bell and the Settings gear
(Settings is not a tab). It loads each time it appears (also
back from a card's screen and when the app comes to the front) and on pull to refresh, keeping the
cards on screen while it loads and when a later load fails. Done cards leave with an animation.
With nothing to do and no sales in either week it shows "You're all caught up"; with sales, a
smaller caught-up card above the money summary. Cards push the item, sale, and marketplaces screens on
Today's own navigation stack (the app passes them in, since a feature never depends on another);
the drafts card switches to the Add Item tab.

### The morning summary

`today_summary` runs every 5 minutes (`runMorningSummaries` in `morning-summary.ts`). An account is
due from its chosen time in its time zone until 2 hours later, at most once per local date: the
job claims the date (`last_sent_on`) in the transaction that queues the notification through the
push outbox ([push.md](push.md)), so two workers or two ticks never send it twice, a worker that
was down sends it late within the window, and turning it on in the evening sends nothing until the
next morning. The notification is built from the same `loadToday` summary ("Ship 2 items (1 due
soon), reconnect eBay, and review 3 drafts. This week: 4 sold for $180."), category
`today_summary`, opening Today. A day with nothing to do is claimed but sends nothing.

The setting is one per account (the notification goes to every device signed in to it):
`getTodaySettings` and `replaceTodaySettings` (`/v1/today/settings`). It defaults to on at 08:00
with no time zone, and nothing is sent without a time zone. The app sends this device's time zone
when the seller saves the setting (the bell on the Today screen), and once per launch replaces a
stored zone that differs from the device's, keeping the seller's on or off and time. A time zone
Postgres does not know (`pg_timezone_names`) is `422 validation_failed`.

## Local development

Nothing to configure: the push driver is the recording fake (`PUSH_DRIVER=fake`), which logs each
morning summary. `make ios-test` runs `TodayUITests`: against `StubAPIServer`, a card of every
kind, each action, the money summary, the all-caught-up state, and the setting's save; against the
local stack, a sold item's ship card (seeded through the control endpoint's `POST /today/sold-item`)
that opens its sale, where Mark shipped finishes it and the card leaves.

## Data

- `today_summary_setting`: one row per account: `enabled`, `local_time` (whole minutes),
  `time_zone` (IANA, null until the app sends one), and `last_sent_on`, the local date of the
  latest summary. Deleted with the account.
- Indexes for the summary's reads: `sale (account_id, sold_at)` for the money summary, and
  `delist_run (account_id, created_at)` over runs that are not completed.

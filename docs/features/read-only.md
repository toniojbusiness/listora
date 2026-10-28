# Read-only connections

A seller can mark a linked marketplace account read only: Listora keeps reading it (imports, its
listings, sold items, sales history, offers, sale checks) but never changes anything on it. It
exists for a real shop the seller wants Listora to watch, or to test reads against, without any
risk to its listings or buyers. The guard is the server's, in depth: every path that could write
to the marketplace refuses on its own, so a bug in one layer is caught by the next.

Code:

- `packages/operations/src/read-only.ts`: what is a write, what is read only, the refusal and its
  message, and turning the setting on and off (`setConnectionReadOnly`).
- `apps/api/src/connections/routes.ts`: `PUT /v1/connections/{marketplace}/read-only`.
- The app's Link accounts screen (`MarketplaceLinkingFeature`): the Read only switch.

## What is read only

- **The setting** is `marketplace_connection.read_only`, which only the account's owner changes,
  in the app (`setConnectionReadOnly`, `403 forbidden` for anyone else; recorded in the audit log
  as `connection.read_only_changed`). Both screens show it (`readOnly` on `Connection` and
  `MarketplaceSession`).
- **A listing is read only** when its connection is, and a listing without a connection when the
  account's connection on its marketplace is: the account has one connection per marketplace, so
  that is the only account on it Listora could be asked to change (`listingIsReadOnly`).
- **A write** is every operation kind but `verify` (`isWriteKind`), and every automation script
  but the reads (`isWriteCall` in `@listora/automation`: `create`, `revise`, `price`, `end`,
  `relist`, `markSold`). Both lists name the reads, so a kind or script added later (a refresh,
  an offer answer, a share) is a write until it is listed as a read.

## Where a write is refused

1. **Queueing.** `enqueueOperation` and `retryOperation` throw `ReadOnlyConnectionError` for a
   write on a read-only listing and queue nothing; the API answers `409 connection_read_only`
   ("Your Depop account is read only, so Listora won't change anything on it. To let Listora change
   it, turn off Read only for Depop in Link accounts."). A read-only listing offers only its check
   (`availableActions`), and every listing action refuses a change before anything else.
2. **Turning it on** fails the changes still waiting to be sent to its listings (queued, or
   waiting to retry) with the same error at once, so the seller sees they won't happen. A step
   already under way finishes its read-back, which only reads.
3. **The engine.** Before a step that could send (an operation `queued` or `retrying`), the
   executor fails a write on a read-only listing with `connection_read_only`, on every host (the
   worker, the browser runner, the phone's claim). That also catches a change queued before the
   setting, by an older process, or by a direct database change. Read-backs still run.
4. **The hosts.** The browser runner opens no browser for a write script on a read-only connection
   (`RunnerSessions` answers `read_only`). The phone's dispatch never hands one to the phone: the
   server answers it itself, even when the setting changed in the middle of a run
   (`phone/work.ts`). The automation adapter maps either answer to a refusal, never to a retry.
5. **The phone runtime.** Every call to a read-only connection carries `readOnly: true`, and the
   runtime refuses a write script with it before any step runs (`read_only`, nothing mutated).
   The runtime is served by the server, so the phone runs the new rule without an app update.

**Items never cross.** An item from a read-only account is never listed on the account's other
marketplaces, and nothing new is listed on a read-only one: creating or publishing such a listing
is refused with `409 connection_read_only` ("This item comes from your read-only Depop account,
so Listora won't list it anywhere else."). So Listora never has to change the read-only account
when the item sells elsewhere, or the other accounts when it sells there.

A refused change is a failure the seller sees, with a Retry that works once they turn Read only
off (`error.retryable` stays true; Retry is refused while it is on).

## Automatic work

Automatic features skip a read-only listing silently and queue nothing for it: no operation, no
task, and no word about it in a notification.

- **Delists after a sale** (`@listora/auto-delist`): a listing on a read-only connection gets no
  delist; an item whose only other listings are read only is simply sold; and a sale on the
  read-only account delists nothing on the account's other marketplaces.
- **Offers** ([offers.md](offers.md)): a read-only account's offers are still read and shown,
  but with no answers: `requestOfferAnswer` refuses one (`409 marketplace_action_unavailable`),
  the phone's claim fails one asked for before the account became read only without sending
  anything, and the phone dispatch would refuse its write script anyway.
- **Features to come** (the automatic listing refresh): they queue through
  `enqueueOperation`, so a write they forget to filter is refused there, which would fail their
  transaction. Each must leave out read-only listings itself: select with `listingIsReadOnly` and
  skip them, as the fan-out does.

Reads keep working on a read-only connection: imports, the listings and sold pages, sales
history, sale checks and sale detection, session checks, label reads, offer reads, and `verify`.

## One-off: the live Depop shop

Migration `20261028061657_depop_shop_read_only` sets the setting on one connection in the
personal deployment: a real seller's live Depop shop with real buyers, linked on 2026-10-28 (its
118 listings imported right after), which Listora must never change. It names the connection by
its id, account, and marketplace, so it changes nothing in any other database, and its down
migration does nothing, so reverting it never makes the shop writable again.

The same migration detaches one stray listing record from that connection: a listing posted
from the owner's own test shop, which relinking the account's Depop left under the live shop's
connection. Without a connection no session, not even a read, ever runs for it there, and it
stays read only through the account's Depop connection. Only Listora's record changes.

## Tests

- `operations/src/read-only.int.test.ts`: every write kind refused and nothing queued, a check
  allowed, a listing without a connection, a change queued before the setting failed by the engine
  without sending, the waiting changes failed when it is turned on, Retry refused until it is off.
- `auto-delist/src/fan-out.int.test.ts`: the fan-out skips a read-only listing silently, and a
  sale on the read-only account delists nothing elsewhere.
- `automation/src/adapter/runner-sessions.int.test.ts`, `automation/src/phone/work.int.test.ts`,
  and `automation/src/phone/read-only.test.ts`: the runner, the phone's dispatch (also mid-run),
  and the phone runtime refuse write scripts and still run reads.
- `apps/api/src/connections/read-only.int.test.ts` and `apps/api/src/listings/views.test.ts`: the
  setting, both screens, the owner rule, the actions offered, the `409`s, and items never
  crossing to another marketplace.
- The app: `ReadOnlyLinkTests` and `APIMarketplaceSessionServiceTests`.

## Data

- `marketplace_connection.read_only` (boolean, default false), migration
  `20261028061656_connection_read_only`.

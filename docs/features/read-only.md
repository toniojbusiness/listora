# Read-only connections

A seller can mark a linked marketplace account read only: Listora keeps reading it (imports, its
listings, sold items, sales history, offers, sale checks) but never changes anything on it. It
exists for a real shop the seller wants Listora to watch, or to test reads against, without any
risk to its listings or buyers. The guard is the server's, in depth: every path that could write
to the marketplace refuses on its own, so a bug in one layer is caught by the next.

Code:

- `packages/operations/src/read-only.ts`: what is a write, what is read only, the refusal and its
  message, and turning the setting on and off (`setConnectionReadOnly`).
- `apps/api/src/connections/routes.ts`: `PUT /v1/connections/{marketplace}/read-only`, and the
  unlink's refusal while read only.
- `packages/db/migrations/20261028172246_marketplace_read_only.up.sql`: the account's setting
  per marketplace, which outlives the connection.
- The app's Link accounts screen (`MarketplaceLinkingFeature`): the Read only switch.
- The app's own refusal ([On the phone](#on-the-phone)): `PhoneReadOnlyGuard` in
  `PhoneExecutionFeature`, and the marks in `Core/Phone/MarketplaceSessionStore.swift`.

## What is read only

- **The setting** is `marketplace_connection.read_only`, which only the account's owner changes,
  in the app (`setConnectionReadOnly`, `403 forbidden` for anyone else; recorded in the audit log
  as `connection.read_only_changed`). Both screens show it (`readOnly` on `Connection` and
  `MarketplaceSession`).
- **A listing is read only** when its connection is, and a listing without a connection when the
  account's connection on its marketplace is: the account has one connection per marketplace, so
  that is the only account on it Listora could be asked to change (`listingIsReadOnly`).
- **A write** is every operation kind but `verify` (`isWriteKind`), and every automation script
  but the reads (`isWriteCall` in `@listora/automation`, whose reads are `read`, `health`,
  `orders`, `listings`, `labels`, `offers`, and `offer`). Both lists name the reads, so a kind or
  script added later (a refresh, an offer answer, a share), or a script name the code does not
  know, is a write until it is listed as a read. Every script is also marked read or write in
  one table (`SCRIPT_ACCESS`), so a new one does not compile until it is classed.
- **Its reads keep the gentler pace** of before 2026-10-28 (`readOnlyPacing` in
  `packages/automation/src/profiles.ts`): 0.3 to 0.8 s before each action on Depop and 0.45 to
  1.1 s elsewhere, where a connection that can write waits the 0.3 s floor. The server hands the
  phone that pace with each call on a read-only connection (`issueCall`), whatever
  `AUTOMATION_<MARKETPLACE>_PACE_MS` says.

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
6. **The app itself.** The iPhone app refuses a write script on an account it holds read only
   before any of the runtime's script runs, whatever the call or the runtime says
   ([On the phone](#on-the-phone)).

## On the phone

The phone runtime is the server's own code, and a call's `readOnly` is the server's word, so on
their own the layers above all trust the server. The app adds one that doesn't:

- **The phone holds an account read only** once it learns so: a call that says `readOnly`, the
  seller turning Read only on in Link accounts, or Link accounts showing the account read only.
  The mark is the app's own, in its Keychain (`MarketplaceSessionStore.setReadOnly`), per
  marketplace, for the signed-in Listora account.
- **It refuses there itself.** Before it loads anything for a call, the app reads the call's
  script, and a write (any script but the reads `read`, `health`, `orders`, `listings`, `labels`,
  `offers`, `offer`: one added later is a write until it is listed) on an account it holds read
  only is answered as the runtime's own refusal (`read_only`, no step, nothing mutated), which the
  server records as refused, never retried (`PhoneReadOnlyGuard`). A call that no longer says
  `readOnly`, or a runtime that would ignore it, changes nothing.
- **Only the seller lets it go**, by turning Read only off in Link accounts on this phone (and the
  server taking it). Until then Link accounts shows the account read only on this phone whatever
  the server says. A mark stays through a sign-out, and goes when another Listora account signs in
  on the phone.

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

## Unlinking and relinking

An unlink and a relink are never a way around the setting:

- **Unlinking a read-only connection is refused** (`disconnectConnection` answers
  `409 connection_read_only`: "Your Depop account is read only, so Listora won't unlink it. To
  unlink it, turn off Read only for Depop in Link accounts first."), checked under the
  connection's lock, and nothing is deleted. The owner turns Read only off first.
- **The account keeps the setting per marketplace** (`marketplace_read_only`), so a connection
  deleted another way (the retention job after a revocation, an operator's purge, eBay's account
  deletion) does not take it along. Database triggers keep it: a row is added when a connection
  becomes read only (or starts so), removed only when its setting is turned off, and kept when
  the connection is deleted. Every new connection of that marketplace on the account starts read
  only (`marketplace_connection_inherit_read_only`, before insert), whichever path creates it:
  linking a session, OAuth, or any other.

A later link of another shop on the same marketplace starts read only too, until the owner turns
it off.

## The shop, not the row

A connection knows the seller its session is signed in as
([marketplace-linking.md](marketplace-linking.md#the-shop-a-connection-holds)), and read only
follows that seller as well as the row (migration `20261029042234_shop_seller`):

- **The account keeps each read-only seller** (`read_only_seller`): a connection that is read
  only while it holds a known seller remembers that seller for the account and marketplace. A
  connection of the account that later comes to hold one of them (a relink on the same row, a new
  link after another shop was linked and made writable) becomes read only again when its check
  records the seller, and its waiting changes fail with `connection_read_only`. Turning Read only
  off with a seller linked forgets that seller only; the others stay.
- **Writes check the shop on the page** before their first step, whatever the setting
  (`expectedSeller`), so a session for another shop changes nothing even before its check runs.

## Protected shops

A protected shop (`protected_seller`) is one Listora only ever reads, whoever links it:

- Every connection that holds it is read only, by a database trigger that sets `read_only`
  whatever writes the row (a link, the Read only switch, a direct database change), on any account.
- The owner can't turn Read only off: `setConnectionReadOnly` refuses with `ProtectedShopError`,
  and the API answers `409 connection_read_only` ("This Depop shop is protected, so Listora will
  only ever read it and Read only stays on."). The app shows that message on the switch.
- Only a migration adds or removes one (no API or app path writes the table), so lifting it is a
  code change the repository's owner merges.
- A shop is named by its seller id, or by the connection that holds it until that connection's
  first recorded seller fills the id in; from then on the seller protects it on any connection.
  The live Depop shop below is protected this way: by its connection until its next session check
  records its seller, so its handle is never in the repository.

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

Migration `20261029042234_shop_seller` makes it a [protected shop](#protected-shops), named by
that connection until its next session check records the shop's seller.

Migration `20261028133845_depop_shop_stray_listings` detaches the other three (ended, with no
Depop listing id), so the live shop's connection holds only its own 118 listings, and marks all
four as from the previous shop, so relinking the live shop never takes them back
([marketplace-linking.md](marketplace-linking.md#relinking-another-shop)). It names each listing
by id, account, connection, and marketplace and checks its state; its down migration does
nothing.

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
  setting, both screens, the owner rule, the actions offered, the `409`s, items never
  crossing to another marketplace, the unlink refused while read only, and a relink after the
  connection was deleted another way starting read only.
- `db/src/constraints.int.test.ts`: every new connection of a read-only marketplace starts read
  only, for that account and marketplace only, until the setting is turned off; a seller kept read
  only makes a connection read only again; a protected shop stays read only whatever sets it,
  learns its seller from its connection, and is protected on any account.
- `operations/src/shop-identity.int.test.ts` and `apps/api/src/connections/read-only.int.test.ts`:
  a seller kept read only, and the owner refused Read only off on a protected shop (`409`).
- The app: `ReadOnlyLinkTests` and `APIMarketplaceSessionServiceTests`; its own refusal and
  marks: `PhoneReadOnlyGuardTests`, `ReadOnlyOnPhoneLinkTests`, and `MarketplaceSessionStoreTests`.

## Data

- `marketplace_connection.read_only` (boolean, default false), migration
  `20261028061656_connection_read_only`.
- `marketplace_read_only` (account, marketplace; one row while the account's connection on that
  marketplace is read only, kept after the connection is deleted), and the triggers that keep it
  and start a new connection read only, migration `20261028172246_marketplace_read_only`. It is
  the seller's setting, not marketplace data, so it stays through an unlink and goes with the
  account.
- `read_only_seller` (account, marketplace, seller id: the sellers the account's read-only
  connections held, kept by triggers, gone with the account) and `protected_seller` (marketplace,
  seller id or the connection that holds it, and why; not an account's, so it stays when an
  account goes), with the triggers that keep read only by seller, migration
  `20261029042234_shop_seller`.

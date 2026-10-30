# Linking marketplaces from the iPhone

Poshmark, Mercari, Depop (until its partner API), and eBay (until its API is connected,
[ebay-automation.md](ebay-automation.md)) are automated in the seller's own session (decision D1,
[automation.md](automation.md)): Poshmark, Mercari, and Depop by the iPhone app that linked them,
eBay by the cloud browser runner ([phone-execution.md](phone-execution.md)).
The seller links each one from the app: **Settings > Link accounts**. This page describes that
flow end to end.

## What the user does

1. Link accounts lists every marketplace linked by signing in, with the server's status:
   `Not linked`, `Checking...`, `Linked`, `Sign in again` (with the marketplace's reason), or
   `Not confirmed` (with the reason). Each row has **Link** (or **Relink** once it had a session).
2. Tapping it opens the marketplace's own sign-in page inside Listora. The user signs in there,
   including any two-step check, then taps **I'm signed in**. Depop can sign in with a link it
   emails instead of a password; see [Emailed sign-in links](#emailed-sign-in-links-depop).
3. The row shows `Checking...` until the check has confirmed that the marketplace accepts the
   session, then `Linked`. A marketplace that runs on the phone is checked on this iPhone at
   once, and its row says "Runs on this iPhone". If the check fails, or has not finished within 15
   minutes, the row says `Not confirmed` and why, and offers **Check again** (the same session,
   no sign-in) next to Relink. A session the marketplace rejected says `Sign in again`.
4. **Read only** (a switch on every linked row: "Listora will never change anything on this
   account") makes the account read only at once; turning it off asks to confirm first. The
   switch shows the server's setting ([read-only.md](read-only.md)).
5. **Unlink** (on every row with a session, or with eBay's API connection) asks to confirm, saying
   what goes ("Listora removes everything it has from Depop: your Depop listings, items that came
   only from Depop, Depop sales and offers with their Pack check orders, and tasks about Depop.
   Items you made in Listora or listed elsewhere stay, without their Depop listing. Nothing
   changes on Depop itself. ..."), then removes it all (`disconnectConnection`,
   [privacy.md](privacy.md#unlinking-a-marketplace)): the row shows `Not linked` once the server
   answered. Listings stay up on the marketplace. The next link, of the same shop or another,
   starts afresh: its first sale check reads the whole sales history, and an import brings the
   listings in again.
   A read-only account is never unlinked: the server answers `409 connection_read_only` until the
   owner turns Read only off, and the row shows that message with Try again
   ([read-only.md](read-only.md#unlinking-and-relinking)).

Marketplaces (Settings > Marketplaces) shows the same status in the same words for the same
connection, with Retry check where Link accounts offers Check again: both screens render one
description of the session (`describeAutomationSession` in `@listora/connections`).

Below the marketplaces, the **Sale emails** section shows the forwarding address that catches
their sold emails, how to set forwarding up, the email provider's confirmation code, and "Ask
before delisting" ([email-sales.md](email-sales.md)).

### Emailed sign-in links (Depop)

Depop may email a "tap to sign in" link. Tapped in the email, it opens the phone's default
browser (Safari or Chrome) and signs in there, where Listora never gets the session; Listora
cannot claim Depop's links (its universal links belong to Depop). So Depop's sign-in page in
Listora shows the steps under the page: "Press and hold the Depop link. If a preview opens, tap
Hide preview, then Copy link. Then come back and tap Paste sign-in link" (Gmail opens a page
preview on press and hold; Apple Mail shows Copy Link directly), with the system's **Paste** button (`PasteButton`, so iOS shows no
paste permission prompt), and "Or press and hold the link, tap Share, then Listora". Either way
the link opens in the same sign-in page (the same web view and data store), and **I'm signed
in** hands over its cookies as for any sign-in. Depop's own password or code sign-in, when its
page offers one, works as before, and nothing the user types is stored.

- Only a genuine sign-in link opens: https (or the sign-in page's own scheme and port, on the
  local stand-in sites), on one of the marketplace's `login.cookieDomains` or a subdomain of one
  (never a look-alike such as `notdepop.com`), with no user name or password in it
  (`SignInLinkRule`, in Core). Anything else is refused with "That isn't a Depop sign-in link".
- Which marketplaces get the steps comes from the server: `login.emailsSignInLinks` (the
  profile's `emailsSignInLinks`, `true` for Depop only).
- **Shared links.** While the page is open (for up to 30 minutes), the app records in the
  Keychain group it shares with the Share Extension that Depop's page waits for a link
  (`SignInLinkHandoff`, `KeychainSignInLinkHandoff`). A share of a link the rule accepts goes
  there instead of the listing flow, and the extension says "Sign-in link sent to Listora. Go
  back to Listora"; an extension cannot open its app. Coming back opens the link in the page,
  once. Closing the page clears the record, so a link shared later is treated as any other share.
- A seller who signed in through the email's link in their browser before this existed relinks
  Depop once: that browser's session never reached Listora.

Listora never sees the password: it is typed into the marketplace's page, the app never reads
the page or runs a script in it, and only the site's cookies are handed over. Listora cannot and
does not read sessions from the marketplaces' own iPhone apps.

## The app (`MarketplaceLinkingFeature`)

- `MarketplaceSignInView` is a `WKWebView` on `WKWebsiteDataStore.nonPersistent()`: a data
  store that is never written to disk and starts empty each time, so every sign-in is fresh. It
  opens only web pages (a page that tries to open another app or scheme is refused). "I'm signed
  in" reads the store's `httpCookieStore`.
- `SessionCookies.capture` keeps only the cookies on the marketplace's `login.cookieDomains`
  (the domain or a subdomain of it, never a look-alike such as `notposhmark.com`) that are still
  alive. A sign-in that went through another site leaves that site's cookies behind, and the
  server refuses a session that carries any. No cookie at all means the user did not sign in:
  nothing is sent and the row says so.
- `LinkAccountsModel` sends the cookies with one Idempotency-Key per sign-in (Try again resends
  the same cookies with the same key), then polls `getMarketplaceSession` every 3 seconds while
  the server says `checking`, for up to 16 minutes, past the server's 15-minute deadline, so a
  row never stays `Checking...` while the server has an answer. A failed poll changes nothing;
  the row stays `Checking...`. Check again calls the connection's `requestConnectionCheck` and
  follows that check the same way. The model never decides on its own that a marketplace is
  linked: every status and label is the server's. Unlink waits for the confirmation, keeps the
  row as it was when the unlink fails (with Try again), and reads the row back afterwards; a
  `404` (nothing linked any more, an earlier try whose answer was lost) counts as unlinked.
- The sign-in page and cookie domains come from the server (`login`), so the app has no
  marketplace URLs of its own; in development they point at the fake site.
- **On the phone.** Before it sends a sign-in, the model makes sure Listora knows this device
  (`registerDevice`), and the link names this installation (`installationId`). It also keeps
  the sign-in's own cookies on the phone, then has the phone run the session's check at once
  when the marketplace runs there ([phone-execution.md](phone-execution.md)). Each session's
  `execution` says where it runs.

## The API

`packages/api-contract/paths/connections.yaml` (tag `connections`; schemas in
`components/schemas/marketplace-sessions.yaml`):

| Operation                 | Route                                         | What it does                                    |
| ------------------------- | --------------------------------------------- | ----------------------------------------------- |
| `listMarketplaceSessions` | `GET /v1/marketplace-sessions`                | Poshmark, Mercari, Depop, and eBay, with status |
| `getMarketplaceSession`   | `GET /v1/marketplace-sessions/{marketplace}`  | One of them                                     |
| `linkMarketplaceSession`  | `POST /v1/marketplace-sessions/{marketplace}` | Stores the session and starts its check (`201`) |

`linkMarketplaceSession` (`apps/api/src/marketplace-sessions/`) calls `linkAutomationSession`
(`@listora/automation`) in the request's idempotent transaction. The session vault encrypts the
cookies with the token key (KMS envelope encryption in AWS, `TOKEN_KMS_KEY_ID`; the API's role
may encrypt sessions but never decrypt them, only the runner's may) and stores them on the
account's `automation` connection, which it creates or revives. In the same transaction the
marketplace's listings that were never on a shop join the connection
([below](#relinking-another-shop)), a `session_check` is requested, and a first sale check is due.

- **Validation.** The contract refuses an unknown field (a password included) and a malformed
  cookie (`422`); the vault refuses a cookie on another site's domain and a session whose
  cookies have all expired (`422`, field `cookies`). Nothing is stored for a refused request.
- **Never logged.** Cookie values appear in no log line, response, or error. The idempotency
  record keeps only a SHA-256 of the request and the response, which holds no cookie.
- A marketplace connected through its API (eBay or Depop) answers `409
marketplace_action_unavailable`, and lists as `api_connected`: the API takes precedence.
- Without a token vault (`TOKEN_ENCRYPTION_KEY` or `TOKEN_KMS_KEY_ID`, read by
  `@listora/connections`) nothing can be linked: `linkMarketplaceSession` answers `409
marketplace_action_unavailable`.

Status (`marketplace-sessions/views.ts`, from `describeAutomationSession`, which Marketplaces'
`Connection` view renders too): no connection is `not_linked`; a connection waiting for a relink
(`reauth_required`) is `needs_relink` with the reason; a working connection is `checking` until
its check passed (`linked`) or failed (`check_failed`). A check still pending 15 minutes after it
was asked for (`SESSION_CHECK_DEADLINE_MS`: a runner that never started, a lost job) is
`check_failed` too, code `check_timed_out`, so nothing stays `checking` forever; so is a session
that was never checked (`check_missing`). `linkedAt` is the connection's `granted_at` (when the
session was linked); a just-linked session has no `lastOkAt` until its check passed.

**Check again** is the connection's Retry check, `requestConnectionCheck`
(`POST /v1/connections/{marketplace}/checks`): for an automation connection that holds a session
it starts a new check of that same session (`requestSessionRecheck`: a new check id and job, the
stored cookies untouched), unless a check is still running within its deadline, which is left to
finish. A connection without a session (`needs_relink`) answers `409 invalid_state_transition`.

### Relinking another shop

An account keeps one connection per marketplace, so the shop linked after an unlink may be
another one (another seller's, or the seller's own second shop). A link therefore never takes
the listings of the shop that was unlinked:

- **Unlink** removes the marketplace's listings altogether
  ([privacy.md](privacy.md#unlinking-a-marketplace)). Every other deletion of a connection
  (access revoked past retention, an operator's purge, eBay's account deletion) detaches the
  connection's listings and marks each as from that previous shop
  (`marketplace_listing.shop_unlinked_at`).
- **A link** takes only the marketplace's listings without a connection that were never on a
  shop (listed before the marketplace was linked). A marked listing stays without a connection:
  no session, not even a read, runs for it, and Listora shows it as before.
- **An import** of the linked shop that finds a marked listing (by its id on the marketplace,
  which only its own shop has) proves it is that shop's: it joins the connection again and loses
  the mark ([imports.md](imports.md)). So unlinking and linking the same shop again loses
  nothing that is still listed there.
- A database check keeps a marked listing off every connection.

**Relink** on a row that is still linked replaces the session of the same connection. Its
listings stay on it while the session signs into the same shop; when its check finds another
shop, they leave it as on an unlink ([The shop a connection holds](#the-shop-a-connection-holds)).

### The shop a connection holds

A connection records the seller its session is signed in as (`marketplace_connection.external_user_id`,
which already held an API connection's seller id), so a session for another shop never changes the
listings of the shop the connection held (audit M3, [security.md](security.md#audit-of-2026-10-28)):

- **Which seller.** The session check's health script returns the signed-in seller's handle,
  trimmed and lower-cased (`sellerIdentity`): Depop's username from the header's Likes link
  (`/<username>/likes/`), Poshmark's username from its page data, the fake site's account. Mercari
  (its account page shows only a display name, neither unique nor fixed) and eBay (Seller Hub is
  not read for it yet) return `null`: the seller stays unknown, never guessed. On the phone, an
  older runtime returns nothing, which the server reads as unknown too.
- **Recording it** (`recordConnectionSeller` in `@listora/operations`, in the transaction that
  records the passed check, so only the newest link's check says): the first seller seen is
  recorded; the same seller changes nothing; **another seller** fails every change still waiting
  on the connection's listings (`shop_changed`: "Your Depop login is for another shop than the
  one this listing is on, so Listora didn't change it. Listora will find the listing again when
  you link its shop.") and detaches the listings (marked as from the previous shop, as a revoked
  connection's deletion leaves them, so an import of a shop that has them takes them back). A failed check records nothing.
- **Before every write.** A write script (and an offer answer) on a connection whose seller is
  known carries it as `expectedSeller`: before its first step, the call runs the health script
  and, when the page shows another seller, changes nothing and answers `rejected`
  `seller_mismatch` ("Listora is signed in to another shop than the one linked, so it changed
  nothing. Link the shop again in Link accounts, then try again."), a failure the seller sees,
  never a retry. A page that doesn't show the seller is not proof of another one: the write goes
  ahead as before. This closes the window between a relink and its check, and catches a session
  that changed under the connection on the phone. It costs one read of the account page per
  write; a runtime older than it ignores `expectedSeller`.
- **Read only follows the seller** ([read-only.md](read-only.md#the-shop-not-the-row)).

## The session check (`packages/automation/src/session-checks/`)

`session_check` holds one row per automation connection: the newest link's check id, its status
(`pending`, `passed`, `failed`), attempts, and the user-readable failure. Each link replaces the
row and its job (`automation_session_check`, job key `session-check:<connection>`), so a job for
an older link records nothing.

The browser runner runs the job (`runSessionCheck`): it opens the session once and runs the
marketplace adapter's read-only health script (an `automation_run` with purpose `health`). For a
connection that runs on the phone, the job hands the check to the phone instead (`phone_work`),
which runs the same script in the seller's session there. The outcomes below are the same. A
check that waits for the phone says `Checking on your iPhone...` (it is waiting, not stuck, so the
15-minute deadline does not apply), and a check the phone meets is handed to the seller to
complete ([phone-execution.md](phone-execution.md#the-phone-runtime)). While a check tries again
after an attempt that didn't get through, its status says so, wherever it runs.

- **Passed** when the script read the seller's account page.
- **Failed, relink** when the marketplace rejected the session or showed a CAPTCHA, a bot check,
  or a verification step: the runner never passes one. Its session handling discards the
  session (`markNeedsRelink`) and opens one `reconnect` task.
- **Failed, can't check** when the marketplace could not be read (a rate limit, an error page,
  a timeout) on three attempts, 30 seconds and 2 minutes apart; the session is kept. Also when
  no automation adapter serves the marketplace yet: its assisted adapter would report healthy
  without opening the session, so the check never asks it. And when the runner's browser could
  not start or open the session (`browser_unavailable`): the marketplace was never asked, and
  the reason says the problem is on Listora's side. The recorded message is the reason only;
  the view adds what the seller can do (check again, or link again).

The worker's dispatcher starts the runner when the job waits (within a minute; it is one of
`RUNNER_TASKS`), and the session check is queued before the first sale check.

## Development

The fake Depop site (`npm run dev:fake-depop-site`) also signs in with an emailed link: its
login page's **Email me a sign-in link** "sends" a one-time link to
`/login/magic-link/?token=...`, which the site logs (and the local stack's control endpoint
serves at `GET /depop/sign-in-link`). Paste it into Depop's sign-in page in the app.

With `FAKE_AUTOMATION_SITE_URL` and the same `TOKEN_ENCRYPTION_KEY` set for the API, the
worker, and the runner, and `npm run dev:fake-site` running, Link accounts opens the fake site's
`/login` for Poshmark, Mercari, and Depop, and its `/signin/` (eBay's own sign-in path) for eBay.
Any username and password sign in there (a `POST` sets the session cookie),
and the runner checks the session against the fake site in local headless Chromium.

## Tests

- `apps/api/src/marketplace-sessions/marketplace-sessions.int.test.ts`: the list (eBay
  included, and its API taking over), the vault
  write (encrypted at rest, readable by the vault), the check job, the statuses, relink,
  idempotent replay, tenancy, every refused session, and that no cookie value is logged,
  returned, or stored in the idempotency record. Its "a linked session on both screens" block:
  Link accounts, `getConnection`, and the health summary say the same thing in every state, a
  check past its deadline is not confirmed, and Retry check checks the same session again.
- `packages/connections/src/session-status.test.ts`: the shared description, its deadline, and
  that Marketplaces renders it exactly.
- `packages/automation/src/session-checks/session-checks.int.test.ts`: the runner's check in real
  Chromium against the fake site: passed, rejected, CAPTCHA, retries then failure, a browser that
  cannot start (its temporary directory not writable, as on Fargate on 2026-10-25), no adapter,
  a replaced link, and the seller it records (a relink on the same row with another shop's
  session gives up the previous shop's listings).
- `packages/operations/src/shop-identity.int.test.ts`: the first seller, the same one, another
  one (waiting changes failed, listings detached), and a seller kept read only.
  `packages/automation/src/adapter/script-call.test.ts`: a write or an offer answer changes
  nothing when another seller is signed in, and goes ahead when the seller is unknown or not
  shown. `packages/automation/src/phone/answers.test.ts`: the phone's seller, and an older
  runtime's answer without one. The recorded Depop and Poshmark hubs
  (`recordings/recordings.int.test.ts`) return the seller's (redacted) handle.
- `CoreTests/SignInLinkTests.swift`: the sign-in link rule (genuine Depop links accepted;
  look-alikes, other sites, other schemes, user info, other ports, and overlong links refused)
  and the Share Extension handoff (once only, only while a page waits, only the marketplace's
  own links, lapsing, cleared on close).
- `MarketplaceSignInModelTests`: a pasted or shared link opens in the same sign-in page, nothing
  else does, and a marketplace that emails no link takes none.
- `MarketplaceLinkingFeatureTests`: the model's linked, needs-relink, failed, and unlink paths, Check
  again, retries, polling that never claims success and outlasts the server's deadline, cookie
  capture, and the API service's request shapes.
- `LinkAccountsUITests`: the real app signs in on a fake marketplace page served by
  `StubAPIServer` and links it; the test checks that the cookie was sent and the password was not,
  then unlinks it.
- `PhoneExecutionUITests`: on the local stack, the app links Depop on the fake Depop site and the
  phone checks the session ([phone-execution.md](phone-execution.md#tests)). One test signs in
  with the fake Depop's emailed link, pasted into the sign-in page (a look-alike link is refused
  first), and links Depop.
- `packages/automation/src/depop/adapter.int.test.ts`: the fake Depop's emailed link signs in
  once.
- `packages/automation/src/link.int.test.ts`: a link takes the listings that were never on a
  shop, a relink in place keeps the connection's listings, and after an unlink the next link (and
  its relinks) takes none of the previous shop's listings, active or ended; the database refuses a
  marked listing on a connection. `packages/imports/src/apply.int.test.ts`: an import puts back
  only the marked listings its shop shows.

## Follow-ups

- The `reconnect` task's deep link (`listora://connections/<marketplace>`) does not open Link
  accounts yet; the app handles no `listora://` links so far.
- Read the seller on Mercari (an id from its page data, not the display name) and on eBay's
  Seller Hub, so their connections know their shop too.

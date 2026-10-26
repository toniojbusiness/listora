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
4. **Unlink** (on every row with a session, or with eBay's API connection) asks to confirm, then
   deletes what Listora holds for that marketplace (`disconnectConnection`,
   [privacy.md](privacy.md)): the row shows `Not linked` once the server answered. Items,
   listings, and sales stay, and listings stay on the marketplace.

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
Listora shows the steps under the page: "Don't tap it. Press and hold it, tap Copy, then come
back here and paste it", with the system's **Paste** button (`PasteButton`, so iOS shows no
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
marketplace's unconnected listings join the connection, a `session_check` is requested, and a
first sale check is due.

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
  and a replaced link.
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

## Follow-ups

- The `reconnect` task's deep link (`listora://connections/<marketplace>`) does not open Link
  accounts yet; the app handles no `listora://` links so far.

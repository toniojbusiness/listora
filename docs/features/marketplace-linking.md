# Linking marketplaces from the iPhone

Poshmark, Mercari, Depop (until its partner API), and eBay (until its API is connected,
[ebay-automation.md](ebay-automation.md)) are automated by the cloud browser runner in the
seller's own session (decision D1, [automation.md](automation.md)).
The seller links each one from the app: **Settings > Link accounts**. This page describes that
flow end to end.

## What the user does

1. Link accounts lists every marketplace linked by signing in, with the server's status:
   `Not linked`, `Checking...`, `Linked`, `Sign in again` (with the marketplace's reason), or
   `Not confirmed` (with the reason). Each row has **Link** (or **Relink** once it had a session).
2. Tapping it opens the marketplace's own sign-in page inside Listora. The user signs in there,
   including any two-step check, then taps **I'm signed in**.
3. The row shows `Checking...` until the browser runner has confirmed that the marketplace
   accepts the session, then `Linked`. If the check fails, or has not finished within 15
   minutes, the row says `Not confirmed` and why, and offers **Check again** (the same session,
   no sign-in) next to Relink. A session the marketplace rejected says `Sign in again`.

Marketplaces (Settings > Marketplaces) shows the same status in the same words for the same
connection, with Retry check where Link accounts offers Check again: both screens render one
description of the session (`describeAutomationSession` in `@listora/connections`).

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
  linked: every status and label is the server's.
- The sign-in page and cookie domains come from the server (`login`), so the app has no
  marketplace URLs of its own; in development they point at the fake site.

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
marketplace adapter's read-only health script (an `automation_run` with purpose `health`).

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
- `MarketplaceLinkingFeatureTests`: the model's linked, needs-relink, and failed paths, Check
  again, retries, polling that never claims success and outlasts the server's deadline, cookie
  capture, and the API service's request shapes.
- `LinkAccountsUITests`: the real app signs in on a fake marketplace page served by
  `StubAPIServer` and links it; the test checks that the cookie was sent and the password was not.

## Follow-ups

- The `reconnect` task's deep link (`listora://connections/<marketplace>`) does not open Link
  accounts yet; the app handles no `listora://` links so far.

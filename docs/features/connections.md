# Marketplace connections (`@listora/connections`)

How a seller connects an API marketplace account, and how Listora keeps and uses its tokens and
the browser sessions of automation connections.
The API side is `apps/api/src/connections`; the worker's side (per-connection tokens for the
adapters, the health check, revocations) is `apps/worker/src/connections.ts`. Adapters are in
[marketplaces.md](marketplaces.md), eBay's connect client in [ebay.md](ebay.md), and connecting
locally against the fake eBay in [ebay.md](ebay.md#connecting-locally).

A seller connects an API marketplace with its
official OAuth 2.0 authorization code grant; Listora never sees a marketplace password.

- **Connect.** `startConnectionAuthorization` stores a `connection_authorization` with the
  SHA-256 of a random single-use `state` (10 minutes) and returns the marketplace's consent URL,
  which the app opens in `ASWebAuthenticationSession`. The marketplace sends the browser to the
  public `handleConnectionCallback`, where the state finds the attempt and is used once; the API
  exchanges the code, reads the seller's immutable id (eBay `getUser`), seals the tokens, and
  stores them on the account's one connection for that marketplace, then redirects to
  `listora://connections/<marketplace>?authorizationId=...`. The app reads the attempt back and
  never trusts the redirect. Reconnecting renews the same connection; a different seller account
  on that marketplace is refused, because the account's listings belong to the connected one.
  `MarketplaceOAuthClient` (`oauth.ts`) is the marketplace side: eBay's (`EbayConnectClient`,
  `ebay/connect.ts`) follows eBay's documented endpoints and needs the keyset's RuName
  (`EBAY_RUNAME`), and the fake eBay serves them locally.
- **Token vault.** Credentials are stored only encrypted, by envelope encryption: a new
  AES-256-GCM data key per seal, wrapped by KMS (`KmsTokenVault`, deployed) or a local key
  (`LocalTokenVault`, development). A credential is one of two kinds: OAuth tokens (`seal`,
  `open`) or a browser session (`sealSession`, `openSession`). Each ciphertext is bound to its
  kind and to the marketplace and connection id (the GCM additional data and the KMS encryption
  context, whose `purpose` is `listora-marketplace-tokens` or `listora-marketplace-session`), so
  neither kind opens as the other. The API holds only a `TokenSealer` (`sealOnly`) and its KMS
  role only `GenerateDataKey`. Only the worker decrypts tokens, and only the browser runner
  decrypts sessions, each at use time; their KMS roles may `Decrypt` only their own purpose.
  Tokens, codes, and states never reach a log line (the callback's request log shows its path
  only) or an operation excerpt; tests check the captured logs.
- **Credentials.** `ConnectionTokens` decrypts a connection's access token when the eBay adapter
  (through `ConnectionSeller`, its `EbaySellerSource`) or the health check asks, keeps it in memory
  until it nears expiry, and refreshes it 5 minutes before it expires. Refresh is single-flight per
  connection: callers in one process share one refresh, and across workers the refresh holds the
  connection's row lock, so a worker that waited finds the new token instead of refreshing again. A
  refused refresh (`invalid_grant`) makes the connection `reauth_required`; one that fails for now
  makes it `degraded`.
- **Health.** The daily `connection_health` job (a worker scheduled task) makes one cheap call per
  connection that still holds its grant (eBay `getUser`, after a refresh if due): it works →
  `connected` with `last_ok_at`; the grant is refused or has run out → `reauth_required`; the
  marketplace cannot be asked → `degraded` with the problem, until a later check succeeds. Every
  check moves `last_checked_at`. `describeConnection` renders the status, a warning 30 days before
  the grant expires (eBay refresh tokens last about 18 months, Depop grants one year), a reconnect
  action whenever only the seller can fix it, and Retry check for a problem Listora keeps checking.
  The [health dashboard](#health-dashboard) shows it all.
- **Session vault** (`SessionVault`, session-vault.ts). The browser session of each automation
  connection ([automation.md](automation.md)): the cookies the app captured when the seller
  logged into the marketplace, on its own domains only, never a password. `linkSession` stores a
  session (creating or reviving the account's automation connection, and closing its open
  `reconnect` tasks), `load` opens it for the browser runner (expired cookies dropped), `rotate`
  stores the cookies the marketplace refreshed during a run, and `markNeedsRelink` discards a
  session the marketplace rejected, or one that met a check automation must not pass: the
  connection becomes `reauth_required` with the problem, and one `reconnect` task (deep link
  `listora://connections/<marketplace>`) asks the seller to log in again. A session that can no
  longer be opened is treated the same way. Every write bumps `credential_version` and names
  the version it read, so an older session never overwrites or discards a newer one. The
  health check, token refresh, and revocation handle only `api` connections.
- **Revocation.** `recordAuthorizationRevocation` (eBay `AUTHORIZATION_REVOCATION`, parsed by
  `parseAuthorizationRevocation`) flips every connection of that seller to `revoked` at once and
  deletes the tokens; a notice older than the current grant changes nothing. eBay's notice
  arrives at `/webhooks/ebay`, which verifies it and records it at once
  ([ebay-notifications.md](ebay-notifications.md)). Account deletion revokes grants through the
  marketplace's revocation endpoint (`OAuthGrantRevoker`). A connection still revoked 30 days
  later, never reconnected, has the rest of the data that came through it deleted; its listings
  and sales stay ([privacy.md](privacy.md)).
- **Read only.** The owner can make a connection read only (`setConnectionReadOnly`, the Read
  only switch on Link accounts): Listora still reads the account but never changes it, and every
  write path refuses ([read-only.md](read-only.md)).
- **Unlinking.** `disconnectConnection` (`DELETE /v1/connections/{marketplace}`) deletes the
  connection and every piece of the marketplace's data in the account at once
  (`startConnectionDeletion` in `deletion.ts`, with `deleteMarketplaceData` in
  `marketplace-data.ts`: the tokens or session, the marketplace's user id and name, its listings,
  the items only its import brought in, its sales with their Pack check orders, offers, sale
  checks, imports, tasks, and events; the history of its operations stays for the owner only)
  and answers with the marketplace `not_connected`; `404` when none is linked. Nothing changes on
  the marketplace. The `connection_deletion` job then revokes an OAuth grant through the
  marketplace's revocation endpoint (for up to 7 days), deletes the stored objects (screenshots,
  and the photos of what went), checks, and records the deletion
  ([privacy.md](privacy.md#unlinking-a-marketplace)). A relink is a new connection and imports
  afresh.

## Health dashboard

The app's Marketplaces screen and its connection banner read one summary, `getConnectionHealth`
(`GET /v1/connection-health`, built by `summarizeConnectionHealth` in `health-summary.ts` from the
same `describeConnection` views `listConnections` returns), so every client says the same honest
thing.

- **The summary.** Every marketplace's connection (eBay, Depop, Poshmark, Mercari), the ones that
  need attention, and the banner the app shows while any does. A connection needs attention when
  it waits for the seller (`reauth_required`: "Reconnect needed"; `revoked`: "Access removed"),
  when its grant ends within 30 days ("Reconnect within N days"), or while Listora cannot reach
  the marketplace (`degraded`: "Connection problem"). What only the seller can fix comes first,
  and the banner is `action_needed` unless every entry is a problem Listora keeps checking. Sale
  email forwarding (`saleForwarding`) is "Set up when you add a domain" until Listora has an
  inbound email domain, and then the account's own forwarding status
  ([email-sales.md](email-sales.md)).
- **Statuses in plain words.** API connections show Connected, Reconnect needed, Access removed,
  or Connection problem; an assisted marketplace with no linked account shows Not linked, and its
  card says it works in assisted mode. The card also shows the mode (API, Automation, Assisted)
  and where its automated steps run, but not when the marketplace last accepted Listora's access
  (`lastOkAt`) or how much work waits for the phone: those are the support views'.
- **Retry check.** `requestConnectionCheck` (`POST /v1/connections/{marketplace}/checks`) notes
  `check_requested_at` and queues `connection_health_check`, the daily check for that one
  connection, in the request's transaction. Until the worker finishes it (`last_checked_at`
  catches up) the connection reads "Checking..." with no actions, for at most 10 minutes, so a
  lost job never leaves it spinning. Only a connected or degraded API connection can be checked
  (`409 invalid_state_transition` otherwise), and only where this deployment can connect the
  marketplace (`409 marketplace_action_unavailable`).
- **The break notification.** The first time a connection leaves a working status (`connected`,
  `degraded`) for one only the seller can fix (`reauth_required`, `revoked`), `recordHealth` (or
  `recordAuthorizationRevocation`) queues a push (`connection_needs_attention`, "Reconnect eBay",
  the problem in the body) in the transaction that records the break
  ([push.md](push.md)). A connection that is already broken never sends it again; reconnecting
  and breaking anew does. A grant that ran out is recorded by the daily check without asking the
  marketplace, so it notifies too.
- **Automation sessions** (decision D1, [automation.md](automation.md)). An `automation`
  connection is shown as its linked session's check says (`describeAutomationSession`,
  session-status.ts), the same description Link accounts renders
  ([marketplace-linking.md](marketplace-linking.md)), so the two screens never disagree: Checking...,
  Linked (only after the session check passed, on the runner or the phone; `lastOkAt` is that
  check, or a later run whose refreshed cookies the marketplace sent), Not confirmed (the check failed or did not finish
  within 15 minutes; attention `not_confirmed`, action `check`), or Sign in again (the marketplace
  rejected the session, shown and notified like `reauth_required`). A connection that runs on the
  phone carries its `execution` (where it runs and what waits there) and says Checking on your
  iPhone... while its check waits for the phone, or Link on your iPhone while no phone holds its
  session; it asks to sign in again only when the phone's own check found the session signed out
  ([phone-execution.md](phone-execution.md#where-a-marketplace-runs)). Retry check on an automation
  connection checks the stored session again (`requestSessionRecheck`) instead of queueing the
  API health check. Without a linked session, Poshmark, Mercari, Depop, and eBay (without its API
  keys) show Not linked.
- **In the app** (`MarketplacesFeature`): one card per marketplace with its mode, status, detail,
  last successful check, where it runs (with Run on this iPhone, or Run in the cloud where the
  server allows the cloud, else why not: [phone-execution.md](phone-execution.md)), and actions
  (Connect, Reconnect, Retry check; the main one filled); a
  Sale emails card; and `ConnectionAttentionBanner`, which Inventory shows above the list while
  anything needs attention and which opens Marketplaces in Settings. The Settings gear in the
  Today and Sales headers gets a dot.

## Data

- `marketplace_connection` (mode, the seller's id (an API connection's immutable id from the
  marketplace, an automation connection's handle as its session check read it,
  [marketplace-linking.md](marketplace-linking.md#the-shop-a-connection-holds)), the encrypted credential (OAuth
  tokens, or the browser session of an `automation` connection, with its `credential_version`;
  [automation.md](automation.md#data)), expiries, scopes, status, when the grant was issued
  (or the session linked), `last_ok_at`, `last_checked_at`, `check_requested_at` (a pending
  Retry check), and the latest problem's code, message, and time; `runs_on` and
  `phone_device_id`, where its automated steps run ([phone-execution.md](phone-execution.md#data)); `orders_polled_through`, the
  eBay order poll's mark ([ebay-notifications.md](ebay-notifications.md)); `read_only`
  ([read-only.md](read-only.md)); a revoked connection
  holds no tokens; at most one per account and marketplace, which
  connecting keeps under the account's row lock) and `connection_authorization` (one connect
  attempt: the state's SHA-256, its expiry, and the result). The marketplace tables they serve
  are in [marketplaces.md](marketplaces.md#data).

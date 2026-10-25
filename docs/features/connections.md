# Marketplace connections (`@listora/connections`)

How a seller connects an API marketplace account, and how Listora keeps and uses its tokens.
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
- **Token vault.** Tokens are stored only encrypted, by envelope encryption: a new AES-256-GCM
  data key per seal, wrapped by KMS (`KmsTokenVault`, deployed) or a local key
  (`LocalTokenVault`, development), and bound to the marketplace and connection id (the GCM
  additional data and the KMS encryption context). The API holds only a `TokenSealer`
  (`sealOnly`) and its KMS role only `GenerateDataKey`; only the worker decrypts, at use time.
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
  `connected` with `last_ok_at`; the grant is refused → `reauth_required`; the marketplace cannot
  be asked → `degraded` with the problem, until a later check succeeds. `describeConnection`
  renders the status, a warning 30 days before the grant expires (eBay refresh tokens last
  about 18 months), and a reconnect action whenever only the seller can fix it.
- **Revocation.** `recordAuthorizationRevocation` (eBay `AUTHORIZATION_REVOCATION`, parsed by
  `parseAuthorizationRevocation`) flips every connection of that seller to `revoked` at once and
  deletes the tokens; a notice older than the current grant changes nothing. The notifications
  task (T-17) verifies and delivers the notices. Account deletion revokes grants through the
  marketplace's revocation endpoint (`OAuthGrantRevoker`).

## Data

- `marketplace_connection` (mode, the seller's immutable id, encrypted tokens, expiries, scopes,
  status, when the grant was issued, `last_ok_at`, and the latest problem's code, message, and
  time; a revoked connection holds no tokens; at most one per account and marketplace, which
  connecting keeps under the account's row lock) and `connection_authorization` (one connect
  attempt: the state's SHA-256, its expiry, and the result). The marketplace tables they serve
  are in [marketplaces.md](marketplaces.md#data).

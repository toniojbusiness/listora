# Threat model

What Listora protects, where trust changes hands, the main threats, and where each is mitigated.
It is short on purpose: the evidence is in the linked code and docs, and the findings of the
security review (with their fixes and follow-ups) are in [security.md](security.md). The
deletion and retention rules are in [privacy.md](privacy.md). Update this file when a feature
adds an asset or a boundary.

## Assets

| Asset                                                                  | Where it lives                                                                                                           | Why it matters                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Marketplace sessions (Poshmark, Mercari, Depop browser cookies)        | `marketplace_connection.token_ciphertext`, sealed by the token vault (`session` purpose)                                 | Whoever holds them acts as the seller on the marketplace                   |
| Marketplace OAuth tokens (eBay, Depop)                                 | The same column, sealed with the `tokens` purpose; during a deletion, `account_deletion_grant` and `connection_deletion` | The same, through the marketplace's API                                    |
| Listora sign-in tokens                                                 | Cognito issues them; the app keeps them in the Keychain; the API verifies them locally                                   | Access to the seller's whole account                                       |
| Photos                                                                 | S3 (`uploads/`, `photos/<account>/` private; `public/<random token>/` for marketplaces), derivatives without metadata    | Personal belongings, sometimes faces or homes; location if metadata leaked |
| Sales and money data (costs, prices, fees, payouts, profit)            | Postgres, per account                                                                                                    | Business-sensitive; tax records                                            |
| Marketplace payloads (notifications, poll results, listing read-backs) | `inbound_event.payload`, `marketplace_listing.remote_snapshot`                                                           | Name the seller's marketplace identity; eBay requires deletion on request  |
| AI inputs and records                                                  | Photos and text sent to the AI provider per analysis; `ai_analysis`, `ai_usage_event`                                    | Item photos leave Listora; costs can be run up                             |
| Automation screenshots                                                 | S3 `automation/<account>/`, redacted before capture                                                                      | Can show marketplace pages                                                 |
| Secrets (KMS key, database password, AI key, signing secrets)          | KMS, Secrets Manager, `.env` locally                                                                                     | Open every sealed credential, or the database                              |

## Trust boundaries

```text
iPhone app ──HTTPS + bearer token──▶ API ──SQL──▶ Postgres ◀──SQL── worker ──▶ browser runner
    │                                 │                              │              │
    ├──▶ Cognito (sign-in)            └──presigned PUT──▶ S3 ◀────────┤              └──▶ marketplace sites
    └──▶ marketplace sign-in view (cookies to the API)                ├──▶ marketplace APIs (eBay, Depop)
marketplaces ──signed webhooks──▶ API          SES inbound mail ──▶ S3 ──▶ worker   └──▶ AI provider
```

| Boundary                            | What crosses it                                                        | Trust rule                                                                                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iPhone app to API                   | Bearer token, item data, upload requests, captured marketplace cookies | Every `/v1` request is authenticated before its body is read and scoped to one account by the tenancy guard ([architecture.md](../architecture.md#4-api-conventions)); bodies are validated against the contract |
| API to storage                      | Presigned uploads                                                      | The signature covers key, type, exact size, and SHA-256; keys are server-generated ([photos.md](photos.md))                                                                                                      |
| API and worker to Postgres          | Everything                                                             | TLS, isolated subnets; composite foreign keys keep rows in their tenant; append-only history ([infra.md](infra.md), [architecture.md](../architecture.md#6-data-model))                                          |
| Worker to marketplace APIs          | OAuth tokens, listings                                                 | Tokens opened only at use time by the worker's KMS grant (`tokens` purpose); success only after a read-back ([connections.md](connections.md), [operations.md](operations.md))                                   |
| Browser runner to marketplace sites | Browser sessions, listing content, screenshots                         | Only the runner opens sessions (`session` purpose); network filter, origin allowlist, stop at every CAPTCHA or check ([automation.md](automation.md))                                                            |
| Marketplaces to the API (webhooks)  | Sale, listing, revocation, and account deletion notices                | eBay's signature over the exact bytes is required; a key that cannot be read fails closed; deduplicated by a unique key ([ebay-notifications.md](ebay-notifications.md))                                         |
| Email ingest                        | Forwarded sale emails                                                  | Not built yet; when it is, an email only triggers a sale check, never records a sale ([security.md](security.md), row 12)                                                                                        |
| Worker to the AI provider           | Item photos (the 1024 px derivative, no metadata) and text             | Budgets, quotas, a kill switch, and account blocks guard every call; the output is validated against a strict schema and only suggests values the seller reviews ([ai.md](ai.md))                                |

## Main threats and mitigations

| Threat                                                                               | Mitigation                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stolen database or backup reveals marketplace credentials                            | KMS envelope encryption bound to a purpose and the connection; the API only seals, the worker opens tokens, the runner opens sessions ([connections.md](connections.md), `infra/src/stacks/compute-stack.ts`)                          |
| A token or session reaches a log                                                     | `REDACTED_LOG_PATHS` in `createLogger`; tests assert no issued secret reaches a log (`packages/connections/src/connections.int.test.ts`)                                                                                               |
| One seller reads or changes another's data                                           | The tenancy guard, account-filtered repositories, composite foreign keys ([security.md](security.md), "Checked and fine")                                                                                                              |
| Account takeover through sign-in                                                     | Cognito with email codes in deployed environments, the dev driver refused by every deploy, guess limits ([auth.md](auth.md))                                                                                                           |
| Forged marketplace notifications record fake sales or revocations                    | Signature verification, dedupe, a revocation only drops a grant (row 13 follow-up: confirm before acting) ([ebay-notifications.md](ebay-notifications.md))                                                                             |
| Automation harms a seller's marketplace account                                      | Only permitted automation (decision D1), per-seller rate limits, stop at every check and hand it to the seller, never store passwords ([automation.md](automation.md))                                                                 |
| A compromised server or deploy runs its own code in the phone's marketplace sessions | The app runs a handed-out runtime only with the offline release key's signature, keeps only the marketplace sites it is built with, and isolates the controller page ([phone-execution.md](phone-execution.md#the-runtimes-signature)) |
| SSRF from the runner or the server                                                   | The runner's network filter; server fetches only fixed or configured hosts ([security.md](security.md), rows 2, 8, 19)                                                                                                                 |
| Photos leak the seller's location                                                    | GPS stripped on the phone and absent from every stored derivative, checked down to the bytes ([privacy.md](privacy.md#photos-carry-no-location))                                                                                       |
| Public photo URLs are guessed or enumerated                                          | 128-bit random tokens; CloudFront may read only `public/*` ([photos.md](photos.md), [security.md](security.md), row 4)                                                                                                                 |
| Data outlives a deletion request                                                     | Deletions delete rows at once, jobs finish outside services, check, and record; the overdue alarm; retention for logs and payloads ([privacy.md](privacy.md))                                                                          |
| A stranger signs up, or reuses or guesses an invite                                  | Invite-only sign-up (`SIGN_UP=invite`), self sign-up off in the pool, 80-bit single-use codes stored as hashes, expiry, revocation that refuses the person's tokens at once, a limit on wrong codes ([invites.md](invites.md))         |
| A deleted person's old token creates a new account                                   | `deleted_identity` and the tombstone refuse earlier tokens ([auth.md](auth.md#account-deletion))                                                                                                                                       |
| False success hides a failed marketplace action                                      | Success only with read-back or user confirmation, enforced by the schema ([operations.md](operations.md))                                                                                                                              |
| AI cost abuse                                                                        | Per-account budgets and quotas, the kill switch, account blocks, the spend alarm ([ai.md](ai.md))                                                                                                                                      |
| Resource exhaustion through uploads or images                                        | Size and pixel limits, unattached uploads expire after 7 days ([security.md](security.md), rows 5, 6, 11)                                                                                                                              |
| A compromised deploy or dependency                                                   | Restricted CDK execution policy, a locked dependency tree (`npm ci`) that the review audited, no secrets in the repository (row 10 follow-up: a permissions boundary on every role)                                                    |

## Accepted and open risks

The open items are the security review's follow-ups ([security.md](security.md)): OAuth consent
linking before public sign-up (row 7), the runner's redirect hops and database credential (rows 8,
9), the deploy role's permissions boundary (row 10), and the smaller items in rows 11 to 19. Apple
token revocation waits for a decision at G-Apple ([auth.md](auth.md)). Listora is a personal-use
app today: one owner per environment and the few people they invite, each in their own account
([invites.md](invites.md)), so every account holder is someone the owner chose, and most
cross-tenant risks (row 7 among them) matter only once public sign-up opens.

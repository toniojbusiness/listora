# Test mode: the owner live-tests hidden features

Sellers see only the marketplace features that passed a live end-to-end test
([verified-features.md](verified-features.md)). A feature gets that test through Test mode. It
is a switch in Settings that only the deployment owner's account has. With it on, that account
sees and runs every built feature, each one not yet verified tagged "Testing", and each run's
result goes in the owner's log. Customers never see Test mode or any unverified feature.

| Where                                                   | What                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `account.test_mode`, `feature_test_run` (migration)     | The account's switch (off by default), and the owner's log of runs             |
| `packages/marketplaces/src/features.ts`, `test-mode.ts` | `FeatureGate`, `isFeatureOn`, `isFeatureInTesting`, `loadFeatureGate`, the log |
| `apps/api/src/marketplace-features/`                    | `listMarketplaceFeatures` (`testMode`, `testing`), `setTestMode`, who may      |
| `apps/admin/src/feature-tests.ts`                       | `npm run admin -- feature-tests`: the owner's log                              |
| `Core/MarketplaceFeatures`, `SettingsView+TestMode`     | The app's switch and the `TestingTag`                                          |

## Who has it

Only the owner or an admin of the deployment owner's account has Test mode. That is the account
whose owner signs in with `SIGN_UP_OWNER_EMAIL` (`SIGN_UP=invite`; [invites.md](invites.md)).
Every other account has no Test mode:

- `listMarketplaceFeatures` has no `testMode` and no `testing` for it.
- `setTestMode` answers `404`.
- The app shows no switch.

A deployment with open sign-up (local development) has no owner, so no account has Test mode.
Local stacks run every feature anyway (`MARKETPLACE_FEATURES=all`).

A flag left on for an account that may no longer use Test mode (`SIGN_UP_OWNER_EMAIL` changed)
is turned off the next time its app reads the list.

## What it turns on

Every gate asks the account's gate: `isFeatureOn(marketplace, feature, gate)`. With Test mode
on, the gate gives the account every feature in `MARKETPLACE_FEATURES`, and
`isFeatureInTesting` names those that are not verified. Each of these then shows and runs for
that account only:

- **Edit listing (`revise`):** the item screen offers it on a live listing, and `reviseListing`
  queues it.
- **Listing refresh:** Settings > Listing refresh, the item's Refresh this item, and the refresh
  scheduler.
- **Offers and offer answers:** reading Poshmark's offers, and Accept, Decline, and Counter.
- **Poshmark's sale checks and imports:** checks in Sync and on the cloud schedule, the overdue
  mark, and Import listings.

The gate is the same one the API, the worker, the browser runner, and the phone's claim use, so
each part runs the same features for the account. The cross-account schedulers (sale checks,
their overdue mark, refresh) include accounts in Test mode.

**Testing tags.** The app tags with a small neutral "Testing" label each feature it shows only
because of Test mode: Settings > Listing refresh, the item's Refresh this item, Edit listing and
its sheet, and an offer on Tasks' offer screen. Lists the server filters (Sync, Import listings,
Tasks) show a test feature's rows without a tag.

## What it never changes

- **Read-only connections stay read-only.** The read-only gates are separate
  ([read-only.md](read-only.md)). Test mode never offers or queues a write on a read-only
  connection: no revise, price change, refresh, or offer answer. Test mode is only ever the
  owner's own account, so it changes no other seller's shop.
- **Nothing is reported done before it is.** A test feature runs through the same operation
  engine, read-back, and Retry as every other ([operations.md](operations.md)).
- **The verified list.** Test mode never marks a feature verified. That still takes a reviewed
  change to `VERIFIED_FEATURES` ([verified-features.md](verified-features.md)).

## The owner's log

Each run of a feature on only because of Test mode is recorded in `feature_test_run` when it
settles, with its outcome (`passed` or `failed`), what ran, and a failure's code and sanitized
words (never page text or anything typed):

| Feature                                   | Recorded when                                                              | Subject      |
| ----------------------------------------- | -------------------------------------------------------------------------- | ------------ |
| `sale_checks`, `listing_import`, `offers` | the read records its health (`recordReadSucceeded`, `recordReadFailed`)    | connection   |
| `revise`, `listing_refresh`               | its operation succeeds (with a read-back) or fails (`transitionOperation`) | operation    |
| `offer_answers`                           | the answer succeeds (read back) or fails (`recordOfferAnswer`)             | offer answer |

A verified feature, or an account not in Test mode, records nothing. To read the log:

```sh
npm run admin -- feature-tests --account <account-id> [--marketplace poshmark] [--json]
# in AWS
scripts/admin-remote.sh <env> -- feature-tests --account <account-id>
```

To mark a feature verified, cite its passed run (date, marketplace, and what it did) in the PR
that adds its `VERIFIED_FEATURES` entry.

## The app

`MarketplaceFeatures` (Core) reads the list, with `testMode` (`unavailable`, `off`, `enabled`),
each time the app comes to the foreground. Settings shows the Testing section only when Test mode
is not `unavailable`. Turning it on or off saves at once (`setTestMode`) and the app shows the
list it returns. A change that fails leaves the switch as it was and says so under it. **The
phone needs a new app build** for the switch, the tags, and Edit listing.

## Tests

- `marketplace-features/test-mode.int.test.ts` (API, real Postgres, verified features):
  - A customer sees no Test mode, gets `404` turning it on, and gets nothing of a flag left on.
  - The owner's switch is off by default. On, it lists every feature with the untested ones
    tagged, revise is offered and queued for the owner, and Poshmark's checks are synced for the
    owner but not for a customer.
  - A read-only connection gets no revise or price change and refuses an offer answer.
  - The owner's log records hidden reads only, and never a customer's.
- `operations/refresh.int.test.ts`: a refresh in Test mode is logged with its outcome.
- `admin/commands.int.test.ts`: `feature-tests`, newest first, with `--marketplace` and `--json`.
- `listings/views.test.ts`: a read-only listing offers no change in Test mode.
- `features.test.ts`: the gate in and out of Test mode.
- `MarketplaceFeaturesTests` (iOS): no Test mode for a customer, the tags, and a failed change.
- `MarketplaceRowStateTests` (iOS): Edit listing only where the server offers revise.

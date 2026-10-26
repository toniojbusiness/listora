# Push notifications

How Listora reaches the seller's phone: sales and delists ([auto-delist.md](auto-delist.md)) and
broken marketplace connections ([connections.md](connections.md#health-dashboard)), and the morning
summary ([today.md](today.md)) today, reminders later. Code: `packages/push` and the worker's `push.ts`
feature.

- **The notification** (`PushNotification`) goes to everyone signed in to an account. It has a
  `category` (such as `item_sold`, the app's notification category), a title and body that are
  safe on a lock screen, an urgency (`time_sensitive` breaks through Focus), a thread id that
  groups one item's notifications, and the ids the app opens when it is tapped. It never
  carries tokens or buyer data.
- **The outbox.** A feature queues a notification with `enqueuePush` in the transaction of the
  change it announces, as a `push_notification` job. It is sent only if that change commits,
  and after the commit, never from inside a transaction. One pending job per key, so a retried
  change never sends twice. A failed send runs again with the queue's backoff, six attempts in
  about ten minutes: a later alert would only repeat what the app already shows.
- **Waking the app.** A notification that `wakesApp` (a sale whose delists run on the seller's
  iPhone) also asks iOS to wake the app in the background. A **background push**
  (`enqueueBackgroundPush`, background.ts) has no alert at all: it only wakes the app to run
  work waiting for the phone ([phone-execution.md](phone-execution.md#when-the-phone-runs)). iOS
  throttles and may drop both, so nothing depends on them.
- **Devices.** The app registers each installation with its APNs token and environment
  (`registerDevice`, the `app_device` table in [phone-execution.md](phone-execution.md#data)). A
  token belongs to one installation: registering it elsewhere moves it.
- **Drivers** (`PUSH_DRIVER`): `fake` (the default) records each notification and logs it, so
  a developer sees what a phone would show, and tests read what was sent
  (`RecordingPushSender`). `apns` (apns.ts) sends over HTTP/2 to every device token the account
  registered, with a token-based provider key (`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`,
  `APNS_TOPIC`; `.env.example`), to the sandbox or production endpoint each token belongs to. A
  token APNs refuses as gone (410, `BadDeviceToken`) is forgotten; any other failed send throws,
  so the outbox job runs again. A notification is an alert; `wakesApp` adds
  `content-available`; a background push is `content-available` alone.

## Open items

- The APNs key in Secrets Manager and `PUSH_DRIVER=apns` in the deployed environment.
- Builds signed with a personal team have no push entitlement, so they get no device token.

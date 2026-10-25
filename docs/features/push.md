# Push notifications

How Listora reaches the seller's phone: sales and delists today ([auto-delist.md](auto-delist.md)),
reminders and reconnect alerts later. Code: `packages/push` and the worker's `push.ts`
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
- **Drivers** (`PUSH_DRIVER`): `fake` (the default) records each notification and logs it, so
  a developer sees what a phone would show, and tests read what was sent
  (`RecordingPushSender`). APNs (a token-based key) joins with device registration.

## Open items

- The APNs driver and the app's device-token registration (`PUSH_DRIVER=apns`).

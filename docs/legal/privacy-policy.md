# Listora privacy policy (draft)

> **DRAFT - not reviewed by a lawyer. Must be reviewed and approved by qualified legal counsel
> before any public release, external TestFlight, or App Store submission.**
>
> This draft is written for the personal environment: one owner running their own copy of
> Listora. It describes what the code does today. Before a public release, counsel must adapt
> it (controller identity, legal bases, regional rights, processor agreements) and confirm every
> statement against the release.

Effective date: [effective date]

Listora is an iPhone app and backend that helps resellers list and manage items on eBay, Depop,
Poshmark, and Mercari. This policy explains what data Listora collects, why, who it shares it
with, how long it keeps it, and how you delete it. "We" means the operator of this Listora
deployment. "You" means the person who signs in.

## Summary

- Listora uses your data only to run the app for you. It does not sell your data, show ads, or
  track you across other apps or websites.
- Listora never stores your marketplace passwords. Marketplace tokens and sessions are
  encrypted.
- Photo location (GPS) and all other photo metadata are removed on your phone and again on the
  server.
- Listora stores no data about your buyers.
- You can delete your account in the app. You can unlink any marketplace at any time.

## What we collect and why

| Data                       | What it is                                                                                                                                                                                                                                                                                                | Why we use it                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Account                    | Your email address and the sign-in identity from our sign-in provider (Amazon Cognito email one-time codes; Sign in with Apple later), and the name and business name you enter in your profile. A profile photo stays on your iPhone and is never uploaded. We never see a password or Apple credential. | To sign you in and to name your account.                                          |
| Item photos                | The photos you take or choose. The app removes GPS and all other metadata before upload. The server removes metadata again from every image it stores, and deletes your original upload once it is processed.                                                                                             | To create listings and to let the AI describe the item.                           |
| Item details               | Title, brand, size, condition, measurements, notes, price, cost, purchase details, storage location.                                                                                                                                                                                                      | To build your inventory and your listings.                                        |
| Sales and money            | Sales, sale prices, fees, shipping costs, expenses, and profit figures. Marketplace order numbers. No buyer names, addresses, or contact details.                                                                                                                                                         | To track sales, delist sold items elsewhere, and show profit.                     |
| Marketplace connections    | For eBay and Depop: OAuth tokens. For Poshmark, Mercari, and Depop: the browser session you hand over when you sign in to the marketplace in the app. The marketplace's user id and user name. Never your password.                                                                                       | To list, update, end, and check your listings and sales on your behalf.           |
| Listing read-backs         | What a marketplace reports about your listings (status, details).                                                                                                                                                                                                                                         | To confirm that an action really happened before showing it as done.              |
| Marketplace notifications  | Notifications a marketplace sends about your account (for example an eBay sale).                                                                                                                                                                                                                          | To record sales quickly and start delisting elsewhere.                            |
| Forwarded sale emails      | Sale emails you forward to Listora, once forwarding is set up.                                                                                                                                                                                                                                            | To detect sales on marketplaces without an API.                                   |
| Automation records         | For browser automation: which step ran, the outcome, and for a failed step a screenshot with every form field and private element blacked out.                                                                                                                                                            | To show you what happened, retry safely, and keep within marketplace rate limits. |
| AI usage records           | For each AI call: the model, token and image counts, cost, and outcome. Not the photos or text themselves.                                                                                                                                                                                                | To meter cost, enforce plan quotas, and stop runaway spending.                    |
| Push notification settings | Your morning summary setting. When push is enabled, your device's push token.                                                                                                                                                                                                                             | To alert you about sales, delists, and connections that need attention.           |
| Server logs                | Request ids, errors, and operational events. Tokens and credentials are redacted.                                                                                                                                                                                                                         | To keep the service running and fix problems.                                     |

## Who we share data with

We share data only to run the app, and only what each party needs.

| Party                        | What they receive                                                                                | Why                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Amazon Web Services (AWS)    | Everything Listora stores, encrypted at rest.                                                    | Hosting, database, storage, sign-in, email, encryption. |
| Anthropic                    | Item photos (resized, without metadata) and item text, for each analysis or voice correction.    | AI item analysis.                                       |
| The marketplaces you connect | Your listing content and the public URLs of its photos, and the actions you ask Listora to take. | Listing and managing your items there.                  |
| Apple                        | Push notification content (never tokens or buyer data), when push is enabled.                    | Delivering notifications. App Store distribution.       |
| Stripe and the App Store     | Billing details, when paid plans launch. Not live yet.                                           | Payments.                                               |

Listing photos must be reachable by marketplaces, so their listing-size and thumbnail images are
served at public URLs through Amazon CloudFront. Each URL contains a random 128-bit token, so it
cannot be guessed and does not reveal your account. Anyone who has the URL can view the image.
Your original photos, the images the AI sees, and screenshots are never public.

We do not sell your data. We do not share it for advertising. We may disclose data if the law
requires it, and then only what is required.

## How long we keep data

| Data                                                           | How long                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------- |
| Your account, items, photos, listings, and sales               | Until you delete them or delete your account.                 |
| Operation history details (redacted request/response excerpts) | 180 days.                                                     |
| Marketplace notifications and parsed email events              | 90 days after they are processed.                             |
| Raw forwarded emails                                           | 90 days.                                                      |
| Browser automation screenshots (redacted)                      | 14 days.                                                      |
| Browser automation run records                                 | 90 days.                                                      |
| AI usage records                                               | 400 days, for cost and quota accounting.                      |
| Unfinished marketplace connect attempts                        | 1 day after they expire.                                      |
| Marketplace data after the marketplace revokes access          | Tokens at once; the rest 30 days later, unless you reconnect. |
| Server logs                                                    | 1 week (personal environment), up to 3 months (production).   |
| Deleted object versions in storage                             | 30 days after deletion.                                       |
| Database backups                                               | 7 days (personal environment), up to 30 days (production).    |
| Deletion records (no personal data)                            | 2 years.                                                      |

## Deleting your data

### Deleting your account

You can delete your account in the app (the app calls `DELETE /v1/account`). When you confirm:

1. Listora deletes your account data from the database at once: items, photos, listings,
   sales, connections, history, and AI usage records.
2. A background job deletes your stored photos and screenshots within minutes and checks that
   they are gone.
3. The job deletes your user at the sign-in provider and asks each connected marketplace to
   revoke Listora's access. It keeps asking for up to 7 days. If a marketplace has not confirmed
   by then, its tokens are deleted anyway, and you should remove Listora in that marketplace's
   settings. Listora lists any marketplace you need to check when you delete the account.
4. The whole deletion completes within 8 days. If it does not, operators are alerted.

Deleted object versions in storage are purged after 30 days, and database backups expire after
their retention period. Listora then keeps only a minimal deletion record: when the deletion
was requested and completed, and counts of what was deleted. It holds no personal data and is
kept for 2 years.

### Unlinking a marketplace

When you unlink a marketplace, Listora deletes at once that connection's tokens or session, the
marketplace user id and name, listing read-backs, marketplace notification payloads, and its
browser automation runs. A job deletes the connection's screenshots within minutes. Listora asks
the marketplace to revoke its access. Your own items, listing history, and sales stay. Listings
stay on the marketplace, but Listora can no longer change or check them until you reconnect.

### When a marketplace ends access

If a marketplace tells Listora that your access was revoked, Listora deletes the tokens at once.
It deletes the rest of that connection's marketplace data 30 days later, unless you reconnect.

### eBay account deletion

When eBay notifies Listora that an eBay user asked eBay to delete their data, Listora deletes
everything it holds about that eBay user: their connection, tokens, user id and name, listing
read-backs, and notifications about them. The Listora user's own items and sales stay.

### Other requests

To ask for a copy of your data, a correction, or a deletion the app does not offer, contact us
at [contact email].

## Security

- Marketplace tokens and sessions are encrypted with AWS KMS envelope encryption. Only the
  backend process that uses them can decrypt them, and the API never returns them.
- Data is encrypted in transit (TLS 1.2 or newer) and at rest.
- The database is on a private network and is not reachable from the internet.
- Browser automation never solves or bypasses CAPTCHAs or bot checks. It stops and asks you.
- Sign-in sessions on the phone are kept in the iOS Keychain.

No system is perfectly secure. If we learn of a breach that affects your data, we will tell you
as the law requires.

## Children

Listora is not directed to children and is not for anyone under 18. We do not knowingly collect
data from children. If you believe a child has used Listora, contact us and we will delete the
data.

## Changes to this policy

We will update this policy when Listora's data practices change, and change the effective date
above. For a material change, we will tell you in the app before it takes effect.

## Contact

Questions or requests: [contact email].

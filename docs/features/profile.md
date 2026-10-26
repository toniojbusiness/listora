# Profile and settings

What the seller sees when they tap their avatar at the top right of Today or Sales: their profile,
then only what a seller needs. The iPhone side is `SettingsFeature` (apps/ios/README.md); the
other features' screens it opens (Link accounts, Marketplaces, the morning summary, sale emails)
are handed to it by `AppFeature`, since a feature never imports another. The server side is the
profile API in `apps/api/src/profile/`.

## The screen

- **The avatar** (`ProfileButton` in AppFeature, `Avatar` in DesignSystem) replaced the gear. It
  shows the seller's photo, or their initials on the brand's soft clay (from their name, else the
  business name, else the email), or a person symbol. A dot shows while a marketplace connection
  needs attention, as the gear's did. VoiceOver reads it as "Profile and settings".
- **Profile** at the top: photo, name, business name, and the email the seller signs in with. A
  tap opens the profile screen, where the name and business name are edited and saved on the
  server (Save stays off until something changed; a failed save keeps what was typed and says
  why), the email only reads, and the photo is added, changed, or removed.
- **Marketplaces**: Linked marketplaces opens Link accounts
  ([marketplace-linking.md](marketplace-linking.md)) and shows one line about every marketplace:
  the server's attention banner while a connection needs the seller (with "Needs attention"),
  otherwise how many connections the server reports with a problem ("1 needs attention") or
  working ("2 working", "None linked yet").
  How Listora connects opens the Marketplaces screen ([connections.md](connections.md)), where
  eBay's API connects.
- **Selling**: Notifications holds the morning summary ([today.md](today.md)), "Ask before
  delisting" ([email-sales.md](email-sales.md)), and, when iOS has notifications off for Listora,
  a banner with the way to iOS Settings. Sale emails shows the forwarding address and its setup,
  or the server's words that this Listora receives no email yet; its row shows the server's
  forwarding status.
- **Support**: Help and contact (common questions, and an email to `SUPPORT_EMAIL` when the build
  names one, otherwise that contact isn't set up yet), the privacy policy, and the terms of
  service. The app bundles `docs/legal/*.md` (project.yml) and `LegalDocument` reads them, so the
  app shows the repository's own words; tables show as cards of label and value pairs.
- **Account**: Sign out, and Delete account ([auth.md](auth.md#account-deletion)).
- **The version** in plain words at the bottom ("Listora 0.1.0"). No server address,
  environment, build number, id, or AI detail shows in the list. A long press on the version (or
  VoiceOver's "Show diagnostics" action) opens Diagnostics, with the version and build, the
  environment, the server address, and the installation id, and Copy all, for support.

## The profile photo

The photo stays on the iPhone and is never uploaded. `AvatarPhoto` re-encodes the picked image at
most 512 pixels on its longest side as a JPEG without the original's metadata (its location among
it), and `FileAvatarStore` keeps it in `Application Support/Profile/<sha256 of the email>.jpg`,
excluded from backups. Signing out keeps the file for the person's next sign-in on this iPhone;
deleting the account deletes it, and so does `LISTORA_RESET_LOCAL_DATA`. A photo saved on the
server (so it follows the seller to another device) is a follow-up.

## API

`getProfile` and `replaceProfile` (`GET` and `PUT /v1/account/profile`, tag `account`):

- `Profile` has the sign-in `email`, the person's `displayName`, and the account's
  `businessName`; a name never entered is absent.
- `PUT` replaces both names: one left out is cleared. Each is trimmed; one blank after trimming
  is `422 validation_failed` with the field, and one over 200 characters breaks the contract's
  schema (also `422`). Nothing is saved then.
- The business name belongs to the account, so a member who is not its owner or an admin changing
  it gets `403 forbidden`; their own name still saves.

## Local development

The dev stack needs nothing extra. `SUPPORT_EMAIL` in `apps/ios/Config/*.xcconfig` (empty in
every committed configuration) names the support address. The UI tests run against
`StubAPIServer`, which answers the profile endpoints (`StubAPIServer+Profile.swift`);
`SettingsUITests` and `ScreenshotTourUITests/testSettingsTour` cover the screens.

## Data

- `app_user.display_name` (existing column, 1 to 200 characters) is the person's name.
- `account.business_name` (migration `20261026060419_profile`, nullable, 1 to 200 characters) is
  the business the account sells as. `account.name` stays the internal label (the owner's email
  at sign-up) that operator reports use.

# Review and price (iPhone)

The screens after Add Item: analysis progress, the confidence-first review, cost, price, and
the saved item. The code is `ReviewFeature` in `apps/ios/Packages/Features`; the app's commands
and its UI tests against the local stack are in [apps/ios/README.md](../../apps/ios/README.md).
It reads the analysis ([ai.md](ai.md)) and the price suggestions ([pricing.md](pricing.md)), and
writes the item ([items.md](items.md)).

## How it works

`ReviewFeature` takes a draft's server item from analysis to a saved inventory item. Each step
saves to the server before the next screen opens, so after a relaunch the flow picks up where
the server is (an item already analyzed reopens in review; a saved one shows as saved). A
reopened item whose photos changed since its analysis was applied is analyzed again.

- **Analysis progress.** It waits for the server to process every photo, starts the analysis
  (`startItemAnalysis`, which returns the existing one for the photo set), and polls it. Every
  wait has a deadline (`ReviewTiming`) and ends in a failure with Try again, never an endless
  spinner. A photo the server could not process, or an analysis that needs other photos, says so
  and offers Edit photos; any other failure that asking again won't fix (such as the plan's
  limit) shows the server's reason and offers Go back.
- **Review, confidence first.** Every detail with its value, its source (AI, Tag, Barcode, or
  You), and the analysis's confidence. Details proposed below 0.6 (the analysis prompt's own
  "a person should check it" line) and empty details every marketplace needs (title, category,
  condition) come first under "Check these", lowest confidence first. The order is fixed while
  the seller edits, so rows never jump. Each detail edits in place, and the typed text is kept
  when the seller continues or opens another detail; canonical ones (category, department, size
  type, condition) are menus of the vocabulary in `Resources/vocabulary.json`, a copy of
  @listora/analysis's that `packages/analysis/src/ios-vocabulary.test.ts` keeps equal.
  The canonical title and description are details too; each marketplace's copy opens in an
  editor that counts its limits. The seller's copy edits stay on this iPhone
  (`ListingCopyStore` in `Core`); the List flow starts each marketplace's draft listing from them
  ([inventory.md](inventory.md)), and from then on the listing carries the copy.
- **Identify harder** is prominent when the brand is missing or below 0.6, or the analysis asks
  for it, and shows the plan's premium identifications (`getUsage`); once they are used up it
  says so and is unavailable. It saves the seller's edits first, so the premium details never
  replace them (`applyAnalysis` keeps `user` details).
- **Cost** on an in-app number pad (whole dollars or cents; no keyboard to open or dismiss), the
  purchase date, and where it was bought, with recent places as one-tap choices.
- **Price.** "Don't sell below" per marketplace (tap for the breakdown), the quick sale,
  recommended, and higher profit tiers, the AI estimate with its confidence, and research links
  that open in Safari. Every source label is the server's, shown as sent. Sold data bound to one
  marketplace (Depop Pricing Inspiration) is not shown here, since this is no listing context.
- **Save** stores the price, the highest floor, and status `ready`, and shows the SKU.
- **Voice and fast corrections.** Hold the mic and say what to change, touch and hold a detail
  for common values, or swipe to the next detail to check: [voice.md](voice.md).

## Interaction time

`InteractionMeter` (in `Core`) measures each new item from its first photo (the camera opening,
or picked photos) to the saved item: the time a screen of the flow shows with the app in the
foreground, minus the time spent waiting on Listora, and the taps in the app window
(`WindowTapCounter` in `AppFeature`; the system keyboard and photo picker are other windows).
The saved screen shows it, the log records it (`metrics` category), and the device keeps the
latest 50. The API has no event for it yet.

## Local development

`make ios-test` runs `ReviewFlowUITests` against the local stack (`packages/e2e`): the API and
worker with the fake AI provider, which answers from `apps/ios/ListoraUITests/FakeAI/default.json`
(a shirt whose brand and color are uncertain). The view models are tested against a fake
service in `ReviewFeatureTests`.

## Data

No tables of its own. The seller's per-marketplace copy edits are JSON files on the device
(`ListingCopyStore`), and the interaction measurements are kept in `UserDefaults`
(`UserDefaultsInteractionStorage`).

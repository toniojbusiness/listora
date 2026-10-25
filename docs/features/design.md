# Listora design

How the iPhone app looks and behaves: the design system in the `DesignSystem` package, the rules
every screen follows, and the UI audit behind design system v2. The code conventions are in
[apps/ios/README.md](../../apps/ios/README.md); this file is about what the user sees.

## Principles

1. **Honest status first.** A status is shown in the server's words, in full, with one of six tones. Only
   `success` looks done (green, a check), and it is used only for what a marketplace read-back
   or the user confirmed. Work in progress is blue, a step that only the user can move on is
   amber, a failure is red and always comes with Retry or a way forward.
2. **One-handed.** The main actions of a screen sit in a bar at the bottom (`bottomActionBar`),
   within thumb reach: Take photos, Import, Add photos, Crop. The camera's shutter is at the
   bottom center.
3. **Camera first.** Adding an item starts with the guided shots (front, back, tag, flaws and
   details); the photo library is the second choice.
4. **No dead ends.** Every empty, failed, or signed-out screen says what happened and offers the
   next step.
5. **Readable for everyone.** Every color pair passes WCAG AA (4.5:1) in light and dark mode,
   every style follows Dynamic Type, every control is at least 44 points, and every control has
   a VoiceOver label.

## Design system v2

All of it is in `apps/ios/Packages/DesignSystem`. Views use these names, never raw colors, fonts,
or numbers.

### Color (`Palette`)

Blush and plum: soft blush tints, a deep plum brand, warm ivory surfaces, and deep plum-black
in dark mode. It was chosen from three directions (with Sage and sand, and Terracotta and cream)
for an audience that is mostly women and also men: refined rather than pastel, and no generic
tech blue.

| Token                                   | Light                         | Dark                              | Use                                       |
| --------------------------------------- | ----------------------------- | --------------------------------- | ----------------------------------------- |
| `background`                            | `#FBF7F4`                     | `#161013`                         | Behind everything                         |
| `surface`                               | `#FFFDFB`                     | `#211A1E`                         | Cards, rows, sheets                       |
| `surfaceSecondary`                      | `#F5ECEA`                     | `#2D2429`                         | Wells inside a card: fields, placeholders |
| `separator`                             | `#EADCD8`                     | `#3A2F35`                         | Hairlines and card borders                |
| `textPrimary` / `textSecondary`         | `#2A1B26` / `#6B5864`         | `#F7EEF2` / `#C4B3BD`             | Text                                      |
| `brand` / `brandSoft` / `onBrand`       | `#6E2A5C` / `#F6E3EC` / white | `#E7A3C9` / `#43213A` / `#2E0F25` | Primary actions, selection                |
| `success` / `successSoft`               | `#2E6B4A` / `#E5F1E9`         | `#86D3A6` / `#173224`             | Confirmed                                 |
| `info` / `infoSoft`                     | `#3D5585` / `#E7ECF6`         | `#A9BCF0` / `#1E2A45`             | Running, checking                         |
| `warning` / `warningSoft`               | `#8F4A12` / `#FBEEDD`         | `#F2C27A` / `#3B2A12`             | Needs the user                            |
| `danger` / `dangerSoft` / `onDanger`    | `#A8243B` / `#FBE6EA` / white | `#FF8A7A` / `#47161F` / `#3A0A14` | Failed, destructive                       |
| `mediaBackground` / `onMedia` / `scrim` | black / white / black         | same                              | Camera and crop, always dark              |

`PaletteTests` checks every text color on every background, every strong color and
`textPrimary` on its soft background, the labels on `brand` and `danger`, and that the brand and
status colors differ from each other, in both modes.

### Type (`Typography`)

SF Pro on Dynamic Type text styles, with the three title styles in New York (serif):
`largeTitle`, `title`, `title3`, `headline`, `body`,
`callout`, `subheadline`, `footnote`, `caption`, `label` (badges and chips), `eyebrow` (section
headers, in capitals), `price` and `priceLarge` (tabular digits). The table with each style's
use is in `Typography.swift`.

### Space, shape, depth, motion

- `Spacing`: an 8-point grid (8, 16, 24, 32, 48, 64) with the 4- and 12-point half steps for
  the inside of small components. Screens use a 16-point margin.
- `Radius`: `small` 8 (thumbnails, chips), `medium` 12 (buttons, fields, photo tiles), `large`
  20 (cards, banners), `extraLarge` 28 (hero tiles).
- `Layout`: `minimumTapTarget` 44, `buttonHeight` 52, `compactButtonHeight` 44, `shutterSize`
  84, `readableWidth` 560.
- `Elevation`: `low` for cards, `medium` for floating bars, `high` for toasts. In dark mode the
  lighter surfaces and hairlines carry the separation.
- `Motion`: `standard`, `snappy`, and `gentle` springs that settle without bouncing. The
  `motion(_:value:)` modifier and `Motion.perform` turn them into a short fade when Reduce Motion
  is on. The photo grid animates reordering, a tapped photo zooms into its detail sheet
  (`matchedTransitionSource`), and banners rise in.
- `Haptics`: tap (shutter), selection (chips), success (draft saved, account connected),
  warning (blurry shot), failure. Views use SwiftUI's `sensoryFeedback` where they can.

### Components

| Component                                  | What it is                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ListoraButtonStyle`                       | `primary`, `secondary`, `destructive`, `tertiary`, `destructiveText`; large or compact; pressed scale; `.loading(_:)` spinner that keeps the size |
| `cardStyle(_:)`                            | `elevated`, `outlined`, or `tinted(tone)` surface                                                                                                 |
| `ListRow`                                  | Icon tile, title, subtitle, trailing accessory; stacks at accessibility sizes                                                                     |
| `IconTile`                                 | An SF Symbol or monogram on a soft square (rows, cards, empty states)                                                                             |
| `StatusTone`, `StatusBadge`, `StatusLabel` | The honest status vocabulary as a pill or as inline text                                                                                          |
| `Chip`, `ChoiceChip`, `FlowLayout`         | Labels over photos (or `muted`, on a card); single-choice chips that wrap                                                                         |
| `ListoraTextField`                         | Labeled field with focus outline, hint, and error                                                                                                 |
| `PriceField`, `PriceInput`                 | Price entry in minor units on the decimal keypad; input kept valid as typed                                                                       |
| `SectionHeader`                            | Small-capitals heading with optional explanation and action                                                                                       |
| `EmptyStateView`                           | Icon, title, message, optional numbered steps, up to two actions                                                                                  |
| `SkeletonBlock`, `SkeletonRow`             | Loading placeholders with a shimmer (a pulse with Reduce Motion)                                                                                  |
| `Banner`, `toast(_:)`                      | Inline status message with Retry or dismiss; a passing confirmation                                                                               |
| `BottomActionBar`, `bottomActionBar(_:)`   | The pinned bar for a screen's main actions                                                                                                        |
| `solidBarEdges()`                          | A hard edge under the navigation bar (iOS 26), so content never shows through; set once at the root                                               |
| `RemoteImage`, `RemoteImageLoader`         | A server photo filling its frame: disk and memory caches, decoded at display size ([performance.md](performance.md#ios)); never `AsyncImage`      |

The review flow enters amounts on its own keypad (`KeypadView` in `ReviewFeature`) rather than
`PriceField`, so the system keyboard never covers the bottom bar; `PriceField` is for amount
fields inside forms.

## Screenshots

`make ios-screenshots` (with `IOS_SIMULATOR=<your simulator>`) runs `ScreenshotTourUITests`,
which visits every screen, in light and dark mode at the default and the largest accessibility
text size. The PNGs land in `.build/ios/screenshots/<variant>/`. Most of the tour uses the stub
API and the debug fake camera (`LISTORA_FAKE_CAMERA`); the review flow (`testReviewTour`,
screens 15 to 26) and the inventory and item screens (`testInventoryTour`, 27 to 34) go through
the local stack with the fake AI and fake eBay, as `ReviewFlowUITests` and `ListingFlowUITests`
do, so the target starts it like `ios-test`. `IOS_SCREENSHOT_TESTS` narrows the tour to one test.
The before and after sheets of design system v2 are in [design/](design/), one per screen
(light, dark, and both at the largest text size). Some "before" cells at the largest text size
are empty: on the old screens at that size the tour could not reach every screen. The camera
had no "before": the simulator could not show it. Sheets 15 to 34 are the second pass, over the
review flow and the inventory (below). The analysis progress (15) shows only when the analysis is slow enough to catch, so
some of its cells are empty too, and the "before" custom price (24, 25) was $269 rather than a
price under the floors.

## UI audit (before design system v2)

Taken on the iPhone 17 simulator from `main` at `c30276e`, in the four variants above.

| Screen            | What looked off                                                                                                                                                                                                                | What changed                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tab shell         | Add Item's `plus.circle` said nothing about the camera-first flow.                                                                                                                                                             | Add Item uses the camera symbol.                                                                                                                                                                                                                                   |
| Inventory (empty) | A lone icon and line in the middle of an empty screen; nothing about how items get there.                                                                                                                                      | A brand icon tile, a friendlier message, three numbered steps, and Add item with the camera icon.                                                                                                                                                                  |
| Add Item          | The one action (Import photos) sat at the top of the screen, out of thumb reach; at the largest text size it scrolled off screen entirely. No explanation of the guided shots.                                                 | Actions in a bottom bar (Take photos, then Import from library); the guide lists the four shots with icons; a privacy note.                                                                                                                                        |
| Camera            | Could not be seen or tested in the simulator. Small controls, the prompt at the bottom competing with the shutter, no step progress, no flash or haptic feedback on capture.                                                   | A fake camera for the simulator; a "Step 1 of 4" prompt card at the top, step chips with checks, an 84-point shutter, a brand Done pill with the count, a capture flash and haptics, a clearer discard dialog.                                                     |
| Drafts list       | The status was small colored caption text; failure reasons ran on in the row.                                                                                                                                                  | A status badge in the honest vocabulary ("Upload failed", "Sign in to upload"); larger thumbnails; a section header with how drafts behave.                                                                                                                        |
| Draft editor      | The status line looked like a plain card in every state; every tile repeated the same cryptic orange icon; at the largest text size the tile labels truncated ("Co...", "Fr...") and covered the photo; Add photos at the top. | A tinted banner per state with Retry; tile badges only for states that are not explained by the banner; capped label size and two columns at accessibility sizes; a brand border and star on the cover; reorder animates; Camera and Add photos in the bottom bar. |
| Photo detail      | A segmented control for five roles, whose text did not scale with Dynamic Type; nothing showed what tag reading found; the photo pushed every control below the fold.                                                          | Role chips that wrap and scale; a "What Listora read" card (reading, lines and barcodes, nothing found, failed); a capped photo height; Crop and Make cover in the bottom bar; Remove in the toolbar.                                                              |
| Crop              | White handles and frame on a light background over a cream photo: the frame was almost invisible; a toggle for Square.                                                                                                         | The editor is always dark, like the system photo editor; L-shaped corner handles; a rule-of-thirds grid while dragging; Original and Square chips; a hint.                                                                                                         |
| Tasks (empty)     | Neutral and flat.                                                                                                                                                                                                              | A success-toned check tile.                                                                                                                                                                                                                                        |
| Settings          | A disabled Send code looked like placeholder text; plain system rows.                                                                                                                                                          | Labeled fields with hints, a real primary button with a loading state, icon rows, section headers.                                                                                                                                                                 |
| Marketplaces      | Four identical gray blocks; every status in the same gray; the explanation was a footer hidden under the tab bar; a plain spinner while loading.                                                                               | A "How it works" card at the top; one card per marketplace with a monogram tile and a status badge; Connect with a loading state; skeleton cards while loading; a dismissible banner for the last attempt with a haptic.                                           |
| Share Extension   | Plain text cards; a manual spinner in the button.                                                                                                                                                                              | Monogram tile on the shared listing, loading button, status badge, icon tiles on the result screens.                                                                                                                                                               |

Contrast held up before (the palette test already enforced AA), but the old palette had no soft
backgrounds or info color, so every non-success status fell back to gray or orange text.

## UI audit of the review flow and the inventory

Taken on the iPhone 17 simulator, in the same four variants: the review flow from `main` at
`e5c60f9` (T-18 had only picked up the v2 tokens), through `testReviewTour`, and the inventory and
item screens from `main` at `750df99` (T-19, built on v2), through `testInventoryTour`.

| Screen    | What looked off                                                                                                                                                                                                                                                                                                               | What changed                                                                                                                                                                                                                                                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flow      | In the review flow, the tab bar stayed up under each screen's own bottom bar, so the main action sat high and the content had less room; each screen drew its own bar and button spinner.                                                                                                                                     | The tab bar hides for the flow and comes back when it ends; every action bar is `bottomActionBar`, and buttons show `.loading`.                                                                                                                                                                                                                                                                            |
| Analysis  | A gray circle icon, and a second spinner under the steps card that repeated the running step.                                                                                                                                                                                                                                 | A brand hero tile and the steps card alone, the running step in bold with an info-tinted spinner. Failures use a danger tile, with Try again and Edit photos in the bottom bar.                                                                                                                                                                                                                            |
| Review    | The attention rows' warning stripe ran past the card's rounded corners; empty details ("Add size") looked like values; "Identify harder" was a second primary button next to Continue; the title truncated at the largest text size.                                                                                          | A warning-bordered card without the stripe; empty details read as a brand "+ Add size" action, acronyms kept ("Add UPC"); Identify harder is secondary in a card with an icon tile; section headers; monogram tiles on each marketplace's copy; the whole title wraps; the voice controls stay on one row and stop growing at the first accessibility size, so Continue stays on screen.                   |
| Cost      | At the largest text size the keypad grew so tall that the date and place sat far below it; recent places were hand-drawn capsules; the place field had no label well.                                                                                                                                                         | The keypad stops growing at the first accessibility size; recent places are choice chips; the place is a labeled text field; "Continue to price".                                                                                                                                                                                                                                                          |
| Price     | Floors sat below the options with nothing linking them, so a price under a floor showed only in the bottom bar; "Set my own price" was a bare link; at the largest text size prices broke across lines ("$18." / "00"); the custom price had its Use button at the top and a half-empty sheet; a plain spinner while loading. | Each option says when it is below a marketplace's floor, and each floor says when the chosen price is under it, prices in one tabular column; the selected option is brand filled; "Set my own price" is a secondary button; at accessibility sizes the price goes under the label; the custom price keeps the keypad and "Use $9.00" at the bottom with the highest floor above; skeletons while loading. |
| Saved     | The SKU, title, and price floated in the middle of the screen.                                                                                                                                                                                                                                                                | A success hero tile, the SKU and price on a card (the SKU to write on the tag), the time and taps as a pill, Done in the bottom bar, and a success haptic.                                                                                                                                                                                                                                                 |
| Inventory | The price column took a third of the card, squeezing the title; a marketplace status chip wider than the row (Poshmark's) was cut off; at the largest text size the title and price broke mid-word ("Levi' s Tr...", "$4 5.0 0").                                                                                             | The title gets the full width and the price ends the SKU line; `FlowLayout` wraps a chip wider than its row instead of cutting it; at accessibility sizes the photo goes above and the price under the SKU.                                                                                                                                                                                                |
| Bars      | Content scrolling under the navigation bar showed through it (iOS 26's soft edge).                                                                                                                                                                                                                                            | `solidBarEdges()` at the root: a hard scroll edge under every bar. An opaque `UINavigationBarAppearance` was tried first; on iOS 26 it hides large titles.                                                                                                                                                                                                                                                 |
| Item      | At the largest text size the header and each marketplace card put the price beside the name ("$45.0 0", "eBa y"), and a status pill cut the server's label short ("Active (confirmed b..."); the labeled rows squeezed their values.                                                                                          | The price goes under the name at accessibility sizes; `StatusBadge` never truncates, so the honest status always reads in full; labeled rows stack their value under the label.                                                                                                                                                                                                                            |
| Listing   | At the largest text size each marketplace's text was squeezed between its tile and the switch.                                                                                                                                                                                                                                | The tile goes above the text at accessibility sizes.                                                                                                                                                                                                                                                                                                                                                       |

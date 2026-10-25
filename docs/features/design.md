# Listora design

How the iPhone app looks and behaves: the design system in the `DesignSystem` package, the rules
every screen follows, and the UI audit behind design system v2. The code conventions are in
[apps/ios/README.md](../../apps/ios/README.md); this file is about what the user sees.

## Principles

1. **Honest status first.** A status is shown in the server's words with one of six tones. Only
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

| Token                                   | Light                         | Dark                              | Use                                       |
| --------------------------------------- | ----------------------------- | --------------------------------- | ----------------------------------------- |
| `background`                            | `#F4F5F7`                     | `#0B0D10`                         | Behind everything                         |
| `surface`                               | `#FFFFFF`                     | `#16191D`                         | Cards, rows, sheets                       |
| `surfaceSecondary`                      | `#EBEDF0`                     | `#22262C`                         | Wells inside a card: fields, placeholders |
| `separator`                             | `#DCDFE4`                     | `#2C3138`                         | Hairlines and card borders                |
| `textPrimary` / `textSecondary`         | `#111418` / `#4B5361`         | `#F3F5F7` / `#A3ABB7`             | Text                                      |
| `brand` / `brandSoft` / `onBrand`       | `#0B7268` / `#DDF3EF` / white | `#2DD4BF` / `#0D3532` / `#032B28` | Primary actions, selection                |
| `success` / `successSoft`               | `#157A3E` / `#E2F5E9`         | `#4ADE80` / `#0E3220`             | Confirmed                                 |
| `info` / `infoSoft`                     | `#1D5FC2` / `#E6EFFC`         | `#7CB4FF` / `#12294A`             | Running, checking                         |
| `warning` / `warningSoft`               | `#9A4806` / `#FDF0DF`         | `#FBBF24` / `#372807`             | Needs the user                            |
| `danger` / `dangerSoft` / `onDanger`    | `#B42318` / `#FDE9E7` / white | `#FF8A80` / `#3D1513` / `#2B0806` | Failed, destructive                       |
| `mediaBackground` / `onMedia` / `scrim` | black / white / black         | same                              | Camera and crop, always dark              |

`PaletteTests` checks every text color on every background, every strong color on its soft
background, and the labels on `brand` and `danger`, in both modes.

### Type (`Typography`)

SF Pro on Dynamic Type text styles: `largeTitle`, `title`, `title3`, `headline`, `body`,
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
| `RemoteImage`, `RemoteImageLoader`         | A server photo filling its frame: disk and memory caches, decoded at display size ([performance.md](performance.md#ios)); never `AsyncImage`      |

`PriceField`, `ChoiceChip`, `ListoraTextField`, and `SectionHeader` are ready for the review and
price screens (T-18), which adopt them after they merge.

## Screenshots

`make ios-screenshots` (with `IOS_SIMULATOR=<your simulator>`) runs `ScreenshotTourUITests`,
which visits every screen, in light and dark mode at the default and the largest accessibility
text size. The PNGs land in `.build/ios/screenshots/<variant>/`. The tour uses the stub API and
the debug fake camera (`LISTORA_FAKE_CAMERA`), so it needs no backend and runs in the simulator.
The before and after sheets of design system v2 are in [design/](design/), one per screen
(light, dark, and both at the largest text size). Some "before" cells at the largest text size
are empty: on the old screens at that size the tour could not reach every screen. The camera
had no "before": the simulator could not show it.

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

# Description style

How Listora's AI writes a seller's listing copy. Each account has a description style: the
instructions the item analysis follows when it writes the Depop draft. It starts as Listora's
default, and a seller who sells differently replaces it with their own in Settings. The code is
`packages/analysis/src/description-style.ts` (the default and the setting), the prompt in
`packages/analysis/src/prompt.ts`, the API in `apps/api/src/description-style/`, and the iPhone
screen in `SettingsFeature/DescriptionStyle/`. The analysis itself is in [ai.md](ai.md).

## Listora's default style

The default is the structure a working Depop shop's current listings follow, measured on 180 of
them (read only, [read-only.md](read-only.md)). The repository holds only the structure and an
invented example, never a real listing's text. In order:

1. A title line: brand, key details, and item type in title case, then the size ("– Size M"),
   then one emoji matched to the item's main color (🤍 white or cream, 🖤 black, 💙 blue or denim,
   and so on). No hashtags on it.
2. One to three sentences opening with an enthusiastic lead ("Such a cute…"), then the fabric,
   construction, and details.
3. Optionally, a sentence on how to style it or its vibe, with an era or aesthetic (Y2K, boho).
4. A bulleted spec list with "• ", `Brand:` and `Size:` first (sizes spelled out), then color,
   material as percentages, origin, and one feature per line.
5. A hedged condition sentence that points at the photos ("Please review photos for overall
   condition and normal signs of wear."), naming each flaw and where it is.
6. 4 or 5 lowercase hashtags, the brand first, then the item type and the aesthetic.

The tone is warm and upbeat and never mentions shipping, bundles, or offers. The style aims at
500 to 800 characters before the hashtags.

## How the analysis uses it

- **The default is in the system prompt.** `ITEM_ANALYSIS_SYSTEM` holds the default style, so it
  is cached with the rest of the prompt and costs nothing extra per call.
- **A seller's own style travels with the item.** When the account saved one,
  `loadAnalysisInput` reads it (`description_style.depop`) and the request carries it as
  `depopStyle`; the system prompt tells the model to follow it instead of the default. The
  system prompt stays the same for every account, so caching is unchanged; only a seller's own
  style adds its tokens to a call.
- **The rules still hold.** A style shapes only the wording and layout of the Depop variant. The
  analysis's accuracy rules (describe only what the photos show, name every flaw, no claims of
  value or rarity, no contact details), the copy limits, and the hashtags' own field come first,
  and the output schema checks the answer as before ([ai.md](ai.md)).
- **Room for the SKU line.** The analysis aims the Depop copy and hashtags at 929 characters
  (`DEPOP_DRAFT_LENGTH`): Depop's 1,000 less the 71 the automation scripts keep for the SKU line
  ([depop-automation.md](depop-automation.md#finding-a-listing-again)). A unit test in
  `@listora/automation` keeps the two numbers in step. The output schema still allows Depop's
  1,000, so a draft a little over is copy the seller shortens on the review, never a failed
  analysis.
- **Analyze once.** A saved style applies to analyses requested afterwards; existing analyses
  keep their copy and are not re-run.

## Settings and the API

Settings > Selling > Description style opens an editor filled with the account's style, marked
"Listora's default" while it is the default. Save keeps the edited text on the server (it is off
until something changed, and while the text is blank or over 4,000 characters); a failed save
keeps the text and says why. "Use Listora's default" shows once the seller has their own and goes
back to the default.

`getDescriptionStyle` and `replaceDescriptionStyle` (`GET` and `PUT
/v1/account/description-style`, tag `account`):

- `DescriptionStyle` has `depop`, the style the Depop draft is written in, and `depopIsDefault`,
  true when it is Listora's default (an account that never saved its own gets the default's text,
  so the app can show it as the starting point).
- `PUT` saves `depop`, trimmed; one blank after trimming is `422 validation_failed` with the
  field, and one over 4,000 characters breaks the contract's schema (also `422`). A body without
  `depop` goes back to the default, and so does saving the default's own text unchanged, so the
  account keeps getting the default's updates.
- The style is the account's (the shop's voice), so a member who is not its owner or an admin
  changing it gets `403 forbidden`.

## Local development

Nothing extra: the fake AI answers from fixtures whatever the style
([ai.md](ai.md), "Providers"). `StubAPIServer+DescriptionStyle.swift` answers the endpoints for
the UI tests, and `SettingsUITests` covers editing and going back to the default.

## Data

- `description_style` (migration `20261028104431_description_style`): one row per account that
  saved its own style, `depop` 1 to 4,000 characters. No row means Listora's default. It is
  deleted with its account.

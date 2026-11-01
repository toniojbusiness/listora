# Measurements (iPhone review)

The seller adds an item's garment measurements on the review: pit to pit, length, waist, inseam,
and rise, laid flat. Depop buyers ask for them before buying vintage and denim, so they also go
into the Depop description. They are saved in the item's existing `measurements` detail
([items.md](items.md)); this feature adds no endpoint or table.

Where the code lives:

- `apps/ios/Packages/Core/Sources/Core/Measurements/`: the measurements the review asks for and
  which fit each category (`MeasurementKind`), one measurement and its text (`ItemMeasurement`),
  and writing them into a description (`MeasurementCopy`). Core, so the List flow
  (`InventoryFeature`'s `SuggestedCopy`) writes them the same way.
- `ReviewFeature`: the form's measurements and the keypad entry (`ReviewMeasurements.swift`), the
  view model (`ReviewFlowModel+Measurements.swift`), the section and the keypad sheet
  (`MeasurementsSection.swift`), and the spoken rule (`VoiceCorrectionParser+Measurements.swift`).

## How it works

- **Only what fits the category.** Tops and outerwear: pit to pit and length. Bottoms: waist,
  inseam, rise, and length (skirts: waist and length). Dresses: pit to pit, waist, and length
  (jumpsuits and rompers: all five). Activewear, swimwear, sleep and lounge, and suits and sets by
  their subcategory (`MeasurementKind.fitting`). Shoes, intimates, bags, accessories, jewelry,
  home, and an item without a category get no section. A measurement the item already has stays
  in the list after its category changes, so a value is never hidden.
- **Typed on the keypad.** Tapping a row opens the in-app number pad (the cost screen's keys, no
  system keyboard) with where to measure; up to three whole digits and two decimals (21.25).
  Save keeps it, Remove (when it has a value) clears it, Cancel changes nothing. New
  measurements are in inches; one the item has in centimeters keeps its unit.
- **Or spoken.** The review's mic takes "pit to pit 21", "p2p twenty two", "inseam thirty and a
  half", "length 27 point 5", "waist 40 cm", and several in one breath ("pit to pit 21 length
  28"). Each is a chip like any other change ([voice.md](voice.md)): nothing changes until the
  seller accepts it, and undo puts the earlier value back. A phrase that only mentions a
  measurement ("high rise", "length is cropped") is not one; it goes to the text model as before.
- **Saved with Continue.** Measurements are the seller's edits to the details, sent with the
  others in Continue's `replaceItem` (provenance "You"). A failed save keeps them on the review
  and shows the error, so Continue tries again.
- **Into the Depop description.** Listora writes one spec line per measurement in the order a
  buyer reads them for the category, in the description's own style
  ([description-style.md](description-style.md)): after its last bulleted line with the same
  bullet (`• Pit to pit: 21"`), or as their own lines at the end when it has no bullets. The
  review's Depop copy shows them at once, the seller's own edited Depop copy gets them too, and
  the List flow writes them into the Depop draft. Writing again replaces the lines Listora wrote
  (and any line the seller typed for a measurement being written), so a changed or removed
  measurement changes the copy and nothing is listed twice. A draft listing that already exists
  keeps its copy. The other marketplaces' copy is unchanged. The lines count toward Depop's
  limit like any copy; going over shows the review's usual warning.

## Local development

Nothing extra: no credential, no server change. `MeasurementCopyTests` (Core) covers the copy
and the categories; `ReviewMeasurementsTests` (ReviewFeature) covers the spoken rule, the keypad
entry, the section's rows, the save, the copy on the review, undo, and a failed save. Fixtures
are invented.

## Open items

- The server's text model (`interpretVoiceCorrection`) does not return measurements; the phone's
  parser reads them.
- The batch rapid review has no measurements section yet.
- Measurements are written into Depop's description only; eBay item specifics and the other
  marketplaces' copy could carry them later.

## Data

No tables of its own: the item's `measurements` detail ([items.md](items.md)).

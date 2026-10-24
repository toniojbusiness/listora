# Synthetic tag corpus

Garment tag images with known text and ground truth, used to measure the tag parsers
(`@listora/tag-parse`) and, through the eval harness, an AI attribute provider.

**Everything here is generated.** `src/corpus/render-corpus.ts` builds it from a fixed seed. It
contains no downloaded datasets, scraped photos, or third-party fonts or images. The license
manifest, `LICENSES.json`, records this: it names the generated files, lists the files written
by hand (`authored`), and has an empty `thirdParty` list. Only openly licensed photos (CC0,
CC BY, or CC BY-SA) may be added, and each one needs a `thirdParty` entry with its file, title,
author, source URL, and SPDX license id. A unit test fails if any corpus file is neither
generated nor listed there, or if an entry names a file that does not exist.

Brands, cities, and web domains are fictional. RN, CA, UPC, and style numbers are random. They
are not meant to identify a real company, product, or registration, and Listora never looks
them up (the FTC RN database must not be scraped or called).

## Layout

- `LICENSES.json`: the license manifest (written by hand; see above).
- `manifest.json`: corpus name, generator version, seed, and the ordered case ids.
- `tags/<id>.png`: the rendered tag. It is 8-bit grayscale, drawn with a built-in 5x7 bitmap
  font, and includes a real EAN-13/UPC-A symbol where the tag has a barcode.
- `tags/<id>.json`: the case:
  - `printed`: exactly what the image shows, top to bottom.
  - `ocr`: simulated on-device reads. These are the printed lines after the deterministic OCR
    noise model in `src/corpus/noise.ts`, plus barcode payloads in the form Apple Vision reports
    them (a UPC-A arrives as a 13-digit EAN-13 with a leading 0).
  - `truth`: the facts printed on the tag, in the `@listora/tag-parse` value shapes.
  - `image`: the file name, its size, and a sha256 of the decoded pixels.

## Providers

`npm run eval` runs the `fake` AI provider by default. It goes through `AiClient` from
`@listora/ai`, so the AI settings in `.env.example` apply (tier models, daily budget, kill
switch), and each call is metered at the configured model's prices. Its answers are fixtures in
`../fixtures/fake-ai/`, one `<photo-set hash>.json` per tag, generated from the ground truth by
`npm run corpus:render`; a unit test fails when they drift from the corpus. The fake therefore
measures the pipeline and its cost, not a model.

`--provider anthropic` sends every tag to the Anthropic API (it needs `ANTHROPIC_API_KEY` and
spends real money, capped by `AI_DAILY_BUDGET_USD`). `--tier premium` uses the premium model.
`--provider stub` echoes the parser facts at no cost, and `--provider none` scores only the
parsers. A provider reports the cost of every call, including a billed call that then fails
(`EvalProviderError` with `usage`), so cost per item counts failures too.

## Cases

Cases named `edge-case-*` are written by hand in `src/corpus/edge-cases.ts`. Each one covers a
trap such as a California ZIP code that looks like a CA number, a bad check digit, or a
"Designed in" line. All other cases are generated.

## Changing the corpus

Never edit the generated files by hand. Change the generator, then bump `GENERATOR_VERSION` in
`src/corpus/generate.ts`, run `npm run corpus:render` (it also rewrites the fake AI fixtures),
and commit the result. A unit test regenerates the corpus in memory and fails if any committed
file differs.

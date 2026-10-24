# Synthetic tag corpus

Garment tag images with known text and ground truth, used to measure the tag parsers
(`@listora/tag-parse`) and, through the eval harness, an AI attribute provider.

**Everything here is generated.** `src/corpus/render-corpus.ts` builds it from a fixed seed. It
contains no downloaded datasets, scraped photos, or third-party fonts or images, so there is no
license manifest. If an openly licensed photo is ever added, it needs a license manifest entry
next to it. Brands, cities, and web domains are fictional. RN, CA, UPC, and style numbers are
random. They are not meant to identify a real company, product, or registration, and Listora
never looks them up (the FTC RN database must not be scraped or called).

## Layout

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

Cases named `edge-case-*` are written by hand in `src/corpus/edge-cases.ts`. Each one covers a
trap such as a California ZIP code that looks like a CA number, a bad check digit, or a
"Designed in" line. All other cases are generated.

## Changing the corpus

Never edit these files by hand. Change the generator, then bump `GENERATOR_VERSION` in
`src/corpus/generate.ts`, run `npm run corpus:render`, and commit the result. A unit test
regenerates the corpus in memory and fails if any committed file differs.

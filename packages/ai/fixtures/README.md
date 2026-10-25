# Fake AI provider fixtures

`FakeAiProvider` answers from these files instead of calling a model. Each file is named
`<photo-set hash>.json`, where the photo-set hash is the request's `photoSetHash`: the item's
`ai_analysis.photo_set_hash`, which is `photoSetHash()` (from `@listora/shared`) over the sha256
of each uploaded photo, sorted so the display order does not change it (`itemPhotoSet()` in
`@listora/photos` computes it).
It is not a hash of the image bytes in the request, which are usually the smaller `ai`
derivatives. Point `AI_FAKE_FIXTURES_DIR` at another directory to use a different set. A
`default.json` in that directory, when present, answers every photo set that has no file of its
own; end-to-end runs use it because their photo sets are not known in advance (the iOS UI tests'
directory is `apps/ios/ListoraUITests/FakeAI`). This directory has none, so an unknown photo set
fails with `fixture_missing` here.

```json
{
  "description": "What these photos are, for people reading the fixture.",
  "outputs": {
    "<output schema name>": { "the answer": "validated against that schema" }
  },
  "usage": { "inputTokens": 1900, "outputTokens": 650 },
  "error": { "code": "truncated", "retryable": false }
}
```

- `outputs` holds one answer per output schema name. A request whose schema has no answer
  here fails with `fixture_missing`; an answer that does not match the schema fails with
  `invalid_output`, as a real response would.
- `usage` is optional and overrides the estimate (image tokens per 28x28 patch, about four
  characters per text token). Fake calls are metered at the configured model's real prices, so
  budgets and the eval harness's cost report behave as they would in production.
- `error` is optional. It makes every call on this photo set fail with that code, still billing
  `usage`, to test failure paths.

The item analysis (`@listora/analysis`) asks for the `item_analysis` schema
(`itemAnalysisSchema`). With `AI_PROVIDER=fake`, an item's analysis fails visibly with
`fixture_missing` until this directory has a `<photo-set hash>.json` for its photos with an
`item_analysis` answer; the analysis tests build theirs in memory, and the eval corpus has one
per tag in `packages/eval/fixtures/fake-ai/`.

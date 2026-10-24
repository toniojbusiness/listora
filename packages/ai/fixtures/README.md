# Fake AI provider fixtures

`FakeAiProvider` answers from these files instead of calling a model. Each file is named
`<photo-set hash>.json`, where the photo-set hash is `photoSetHash()` over the sha256 of each
image in the request, in order (the same key as `ai_analysis.photo_set_hash`). Point
`AI_FAKE_FIXTURES_DIR` at another directory to use a different set.

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

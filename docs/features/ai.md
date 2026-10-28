# AI pipeline and cost metering

AI cost is a product constraint, so each item is analyzed once, as cheaply as possible.

1. **On device (free):** capture guidance, Vision text recognition on tags, barcode detection.
2. **Deterministic server parsing (free):** `@listora/tag-parse` reads RN/CA numbers, UPC/EAN
   (check digit verified), sizes with their system, fiber percentages, country of origin, and
   labeled style numbers from OCR lines and barcode payloads. Every value carries a confidence
   and its source line. Never scrape or call the FTC RN database.
3. **One multimodal call** (Claude Haiku 5.5, low effort, a JSON schema every answer is
   validated against; not strict structured output, see the deviation below). It returns
   canonical attributes with per-field confidence and provenance, plus every marketplace
   variant and a labeled price estimate. Typical cost is about $0.0015-0.003 per item.
4. **Escalation** (Sonnet 5.5) only for low confidence, designer or vintage items, or when the
   user taps "Identify harder". It counts against the plan's premium quota.
5. **Analyze once.** There is one `ai_analysis` per item, photo-set hash, and tier
   (`standard`, plus `premium` only after escalation). Edits, repricing, delist, sync, and
   profit tracking never call AI. Bulk work uses the Batch API. The exceptions are short text
   calls on the standard tier, with no images and no plan quota: a spoken correction the phone
   could not parse (purpose `voice_correction`, [voice.md](voice.md)), and the marketplace
   pre-fill's questions Listora's mapping can't settle, one call per item at most, each question
   asked once (purpose `marketplace_prefill`, [marketplace-prefill.md](marketplace-prefill.md)).
6. **Evaluation.** `npm run eval` scores the parsers, and providers behind the `EvalProvider`
   interface, on the synthetic tag corpus in `packages/eval/corpus`: AI tag reading, and the
   full production analysis (`analyzeItem`), scored on the tag facts it reports. It prints
   per-field accuracy, precision, recall, and cost per item, including the billed cost of
   failed calls.
   The `fake` (default) and `anthropic` providers go through `AiClient`, so the guards, the
   tier's model (`--tier`), and metering are the production ones.
   The parsers must stay at or above 95% on every field (a unit test enforces this). Providers,
   the corpus license manifest, and how to change the corpus are described in
   [packages/eval/corpus/README.md](../../packages/eval/corpus/README.md).
7. **Metering from day one.** Every call writes an `ai_usage_event` (tokens, images, searches,
   `cost_micros` from a versioned price table). The system also keeps daily and monthly
   rollups and per-plan quotas in reseller units. There is a per-account daily dollar circuit
   breaker (default $1/day), a global kill switch, per-account blocks, and spend alerts.

`@listora/analysis` implements steps 3 to 5 on top of `@listora/ai`:

- **Request.** `startItemAnalysis` needs every photo of the item `ready` (the photo set is all
  of them) and returns the existing analysis of the photo set when there is one; a `failed`
  one is queued again, since asking again is the retry. Before anything is queued, the API
  runs the AI guards (`AiClient.checkGuards`) with the tier's plan unit, so a request that
  would be refused gets `503` (kill switch), `429` (daily budget), or `402` (quota) instead.
  The row and its job commit together (`requestAnalysis`).
- **The call.** `analyzeItem` sends at most 5 photos' `ai` derivatives (the first tag photo
  wherever it is, then the others in display order) and at most one tag crop: a 784 px
  centered crop of that tag photo when it is sharper than the `ai` image (`tagCrop` in
  `@listora/photos`). Those caps (`MAX_ANALYSIS_PHOTOS`, `MAX_TAG_CROPS` in `input.ts`) are the
  plan's cost basis (3-5 photos and one tag crop per call), which the plan limits and the
  daily circuit breaker were sized for. The prompt is JSON with the phone's OCR lines and
  barcodes and the `@listora/tag-parse` facts. The system prompt holds every rule and the
  canonical vocabulary (`vocabulary.ts`: category tree, departments, colors, patterns,
  materials, size systems, conditions) and nothing per item, so it caches. The answer's
  schema (`itemAnalysisSchema`) also enforces each marketplace's copy limits
  (`marketplace-copy.ts`, with their sources) and cross-field rules; an answer that breaks it
  is `invalid_output`, retried once, then the analysis fails with a reason the user sees.
  The Depop variant follows the account's description style: Listora's default in the system
  prompt, or the seller's own in the request ([description-style.md](description-style.md)).
  The answer is flat (details as plain values, empty when not found, with their confidences
  in a parallel object; decoded before use), and its schema travels in the system prompt
  (`enforcement: 'prompt'`).
- **Deviation from the plan: no strict structured output.** Plan section 5.1 calls for
  structured output with a strict JSON schema (constrained decoding). In the live runs
  Anthropic refused this schema as a strict grammar ("compiled grammar is too large"), even
  after flattening it, so strict mode is not possible for it. The adopted fallback: the full
  JSON schema in the cached system prompt, every answer validated against the Zod schema
  (`itemAnalysisSchema`), and one retry of an answer that breaks it. The cost is an
  occasional billed `invalid_output` retry, and a visible failure after a second bad answer;
  an invalid answer is never stored.
- **Provenance** is the server's: a value is `ocr` or `barcode` only when the phone's reads
  contain it, otherwise `ai`. A confident parsed fact the model agrees with gives its source;
  one the model left out fills the value in; one it contradicts caps the value's confidence
  at 0.5 so the review screen highlights it.
- **Escalation.** A standard result asks for the premium identification when its brand or
  product is uncertain (confidence below 0.6), the item looks designer or vintage, or the
  model says so. With `AI_AUTO_ESCALATE=on` the job then queues the premium analysis (same
  photos plus the first result) in the transaction that stores the result, when the premium
  quota allows; otherwise the user starts it (`escalateAnalysis`). A brand the model did not
  identify at all also sets `needsEscalation` (with the reason "The brand was not
  identified."), so the app makes "Identify harder" prominent, but never escalates on its own:
  many items are unbranded, and a premium identification costs the user's quota. A missing
  product name alone sets nothing, since most secondhand items show none.
- **Quotas.** A standard call uses one `ai_items` unit and a premium call one
  `premium_identifications` unit when it succeeds. `PostgresQuotaPolicy` counts them in
  `usage_counter` per UTC month and enforces the row's `quota` (null means unlimited until
  billing, T-28, sets plan limits). `GET /v1/usage` reports the same counters, so the app shows
  what "Identify harder" uses and what is left.
- **Applying.** `applyAnalysis` copies the proposals into the item with their provenance and
  sets `acceptedAnalysisId`, never overwriting a detail whose provenance is `user`. A later
  `replaceItem` value equal to the accepted analysis's proposal keeps the analysis's source.
- **The job** (`runItemAnalysis`, task `item_analysis`, run by the worker) records every
  outcome on the row, unexpected errors included (`internal_error`, retryable), so an
  analysis never stays `running` or claims a result it does not have: a failed one shows its
  reason and whether asking again may help. Only a database outage while recording throws;
  the queue then runs the job again with backoff.

`@listora/ai` is the provider layer behind steps 3, 4, and 6, and implements step 7's metering,
guards, cost reports, and spend check (the AI cost alarm is in
[observability.md](observability.md#trust-metrics-and-alarms)):

- **`AiClient` is the only way to call AI.** A call names its account, purpose, and tier
  (`standard` is the Fast tier, `premium` the escalation). The client checks the guards in
  order: the global kill switch (`AI_KILL_SWITCH`, or the operator's switch in Postgres), an
  operator's block on the account, the account's spend today in UTC against
  `AI_DAILY_BUDGET_USD`, and the plan quota hook (`QuotaPolicy`, in reseller units such as
  `ai_items`). `createAiClient` adds the operator controls when given `PostgresAiControls`. A
  tripped guard throws `AiGuardError` before anything is sent and records nothing. Quota units
  are consumed only when a call succeeds.
- **Tiers map to models by configuration** (`AI_MODEL_STANDARD`, `AI_MODEL_PREMIUM`); the
  default registry is Haiku 5.5 at low effort and Sonnet 5.5 at medium effort. Every
  configured model must be in the price table, so every call can be priced.
- **Prices** live in `packages/ai/src/prices.ts` as integer micro-dollars per million tokens.
  A price change adds a new table version; each event stores the version it was priced with.
  Costs round up to the next micro-dollar, once per call.
- **Every call is metered, failed ones too.** The provider reports what it billed (a
  truncated or invalid answer still costs tokens), and the event records it with
  `outcome = 'failed'` and an `error_code` before `AiCallError` is thrown. Providers send one
  request per call and never retry, so each request the vendor sees is its own event. If the
  call's item or user is deleted while it runs, the event is still recorded, without that
  reference.
- **Rollups.** A trigger adds each event to `ai_usage_daily` for its account and UTC day, and
  the daily budget guard reads that row. `UsageStore.monthlyUsage(accountId, 'YYYY-MM')`
  returns an account's totals for a UTC calendar month (cost, calls, failed calls, tokens,
  images, and web searches) by summing the month's daily rows; the table's
  `(account_id, usage_date)` primary key serves that range scan, so there is no separate
  monthly table or index.
- **Operator controls.** `PostgresAiControls` keeps the global kill switch (`ai_kill_switch`,
  one row) and per-account blocks (`ai_account_block`) in Postgres. The client asks them on
  every call, so a change takes effect on the next call in every process, with no deploy.
  Operators change them only through `npm run admin -- ai-kill-switch on|off` and
  `ai-block on|off <account>`, which require `--actor` and `--reason`. Each change and its
  `ai_control_audit` row commit in one transaction, and a request that changes nothing
  (switching on a switch that is already on) records nothing. `AI_KILL_SWITCH=on` stays as a
  deploy-time switch: either one refuses calls.
- **Cost reports.** `npm run admin -- ai-cost ...` reports, for a UTC day or month: top
  accounts by spend and one account's usage (from `ai_usage_daily`, and for one account's month
  from `UsageStore.monthlyUsage`), AI cost per item worked on, and spend by purpose, tier, and
  model (from `ai_usage_event`). An item's cost includes its failed calls and escalations.
- **Spend check.** `checkAiSpend` runs every hour (minute 7, UTC) as the worker's
  `ai_spend_check` Graphile Worker cron task, once per hour across all workers, in the
  worker's task pool (not the operation steps' pool), with the thresholds from the worker's
  own environment; `npm run admin -- ai-alerts check` runs it once
  on demand. It flags accounts approaching (`AI_ALERT_WARN_PERCENT`, default 80%) or over
  the daily circuit breaker or an AI plan quota in `usage_counter`, and all accounts together
  approaching or over `AI_GLOBAL_DAILY_ALERT_USD` per UTC day. It only reads. It logs one
  `event: "ai_spend_alert"` line per alert (warn when approaching, error when over) and one
  `event: "ai_spend_check"` summary with numeric counts, through the worker's logger when
  scheduled. CloudWatch metric filters and alarms (T-30, T-32) key on these field names, so
  they change only together with the alarms. Alerts name accounts by id only.
- **Operator surface.** The cost reports, the kill switch, and account blocks are the admin
  CLI (`npm run admin`), and the spend alerts the worker's hourly spend check (T-29). Admin
  HTTP endpoints are deferred: Listora is for personal use for now, and the CLI is enough. The
  CloudWatch alarm that notifies on AI daily cost comes with T-32.
- **Timeouts.** `AI_REQUEST_TIMEOUT_MS` defaults to 600000 (the SDK's own default), so long
  Premium calls are not cut off. A timed-out call may still be billed but is metered at zero.
- **Providers.** `FakeAiProvider` answers from fixture JSON keyed by the request's
  `photoSetHash` (the item's `ai_analysis.photo_set_hash`, not a hash of the images sent) and
  output schema name (`packages/ai/fixtures/README.md`; a `default.json` in the directory answers
  every other photo set, for end-to-end runs), validates it against the schema, and
  estimates usage the way the API counts it. Fake calls are metered at the configured model's
  real prices so budgets behave the same in development. `AnthropicProvider` uses the official
  SDK with strict structured output (`output_config.format` from the Zod schema; an output
  with `enforcement: 'prompt'` sends the JSON schema as system instructions instead), base64
  images, the tier's effort, and a prompt-cache breakpoint on the system prompt. Its live smoke
  test runs only when `ANTHROPIC_API_KEY` is set.

## Data

- **AI:** `ai_analysis` (unique per item, photo-set hash, and tier; a `premium` one names the
  standard analysis it escalates; a failed one records whether retrying may help),
  `ai_usage_event` (one
  append-only row per provider call, with its tier, outcome, and error code), and
  `ai_usage_daily`, which a trigger on `ai_usage_event` keeps in step per account and UTC day.
  Monthly totals come from `UsageStore.monthlyUsage` (above). The operator controls are
  `ai_kill_switch`, `ai_account_block`, and the append-only `ai_control_audit`.

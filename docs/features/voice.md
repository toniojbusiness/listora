# Voice and fast corrections (iPhone review)

The seller holds the mic on the review screen and says what to change: "size medium, small
stain on the left cuff, paid four dollars at Goodwill". Each change is proposed as a chip to
accept or dismiss; nothing changes until the seller accepts it, and an accepted change is the
seller's own edit (provenance "You"). The review also has two touch shortcuts: touch and hold a
detail for its common values, and swipe left (or "Next") to move to the next detail that needs a
look. The screens are in [review.md](review.md).

Where the code lives:

- `apps/ios/Packages/Core/Sources/Core/Voice/VoiceTranscriber.swift`: the speech-to-text
  protocol and the permission states.
- `VoiceInputFeature`: `AppleSpeechTranscriber` (Speech framework and `AVAudioEngine`) and
  `ScriptedVoiceTranscriber` (UI tests). `AppDependencies` picks one.
- `ReviewFeature`: the parser (`VoiceCorrectionParser`, `SpokenAmount`), the changes
  (`VoiceChange`), the view model (`VoiceCorrectionModel`), how the review applies and undoes
  them (`ReviewFlowModel+Voice.swift`, the `VoiceCorrectionTarget` protocol a batch review can
  implement too), the common values (`QuickValues`), and the tray, chips, and talk button
  (`VoiceCorrectionView.swift`).
- Backend: `interpretVoiceCorrection` (`POST /v1/items/{itemId}/voice-corrections`) in
  `apps/api/src/voice/`, and the text-model call in `@listora/analysis`
  (`voice-correction.ts`).

## How it works

1. **Speech to text on the iPhone.** While the mic is held, `SFSpeechRecognizer` transcribes for
   the seller's language, on the device when the device supports it (free and offline);
   otherwise Apple's recognition service does it. Audio never goes to Listora. Letting go waits
   up to 2 seconds for the final transcript, then uses the latest partial one. VoiceOver users
   double-tap to start and again to stop.
2. **Deterministic parse first (free).** `VoiceCorrectionParser` splits the transcript at
   punctuation (not inside "$1,200", "4.50", or "J.Crew"), then at "and", "also", "plus", and
   "then" when a phrase does not parse as a whole, drops filler ("um", "it's a", "the"), and maps
   each phrase with fixed rules: sizes (letter, numeric, waist x inseam, US/UK/EU, one size; a
   plain number is a US size on shoes), department, colors, pattern, materials (canonical values
   from the vocabulary copy), condition words (NWT, "gently used", ...), "no flaws", flaws (a
   phrase naming one, added as said), measurements ("pit to pit 21", several in one phrase;
   [measurements.md](measurements.md)), the price paid with where it was bought, the price to list
   at ("price at 30"), brand, category, title, product name, style number, keywords, and
   condition notes. Amounts are integer cents, read from digits or words ("four fifty" is
   $4.50). A later change to a detail replaces an earlier one ("size small, no wait, size
   medium").
3. **Text model only for the rest.** Phrases no rule maps are sent, as text only (never audio,
   at most 500 characters), to `interpretVoiceCorrection`. The API calls the standard tier (the
   cheap text model) through `AiClient` with purpose `voice_correction`, so the kill switch, the
   account block, and the daily dollar budget apply and the call is metered in
   `ai_usage_event`; it uses no plan quota. The answer is normalized on the server: canonical
   fields keep vocabulary values only, amounts become `Money`, text stays within its detail's
   limit, and anything else is dropped. It is a proposal only: the endpoint changes nothing. Its
   `Idempotency-Key` is kept for the utterance, so "Try again" after a failure replays an answer
   that did arrive instead of paying twice.
4. **Chips.** Each change is a chip ("Size: M", "Paid: $4.00"; the text model's carry a
   sparkle). A change that would leave a value as it is is not proposed. Accept applies one
   (Accept all, all of them), dismiss drops it, and undo takes an accepted one back (it is
   offered again). Accepted details are form edits, saved with Continue like typed ones; the
   price paid and where it was bought fill the cost screen, and the list price becomes the
   price screen's custom price. Done closes the tray and drops what is still pending.
5. **Failures.** Nothing heard, recognition failing, the text model being unavailable (`503`,
   with Try again), the daily budget (`429`), or AI being off for the account (`403`) each show
   a message under the mic; the changes the phone understood stay proposed. A phrase the text
   model could not map says so, so the seller edits it by hand.

**Permissions.** The first hold explains what voice needs and offers "Turn on voice", which
asks for speech recognition and the microphone (the usage strings are in `project.yml`). When
either is turned off, the message says so with "Open Settings", and the typing field opens:
typed corrections go through the same parser and chips. A device policy or a language without
speech recognition falls back to typing too.

**Fast corrections.** Touching and holding size, colors, materials, pattern, or flaws shows
common values (colors and materials toggle; flaws add; sizes also set the size type). Swiping
left on a detail, or "Next (n)" in the bottom bar, moves to the next detail still needing a look
in the review's order, wrapping around, opens its editor when it is typed in place, and scrolls
to it.

## Local development

No credential is needed. The fake AI answers `voice_correction` from the fixture directory like
any other output (`packages/ai/fixtures/README.md`); the iOS UI tests' `FakeAI/default.json`
answers every transcript with the keyword "embroidered logo". The simulator has no microphone,
so UI tests set `LISTORA_VOICE_TRANSCRIPT` (what the mic "hears") and optionally
`LISTORA_VOICE_PERMISSION=denied|restricted`; Dev builds only. The parser and the view model are
tested in `ReviewFeatureTests`, the endpoint in `apps/api/src/voice/voice.int.test.ts`, and the
whole path in `ReviewFlowUITests`.

## Data

No tables of its own. Each text-model call is an `ai_usage_event` with purpose
`voice_correction` ([ai.md](ai.md#data)); the accepted changes are the item's details.

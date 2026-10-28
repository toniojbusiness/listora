# Recorded marketplace pages

Tests run the Depop, Poshmark, and Mercari automation scripts against **recordings of the real
pages**, not only against hand-made fakes. The fakes were written from Listora's own model of
each site, so a test could pass while the real site failed (the fixes in #115, #117, and #120
were all pages the fakes drew differently). A recording is what the real page was while the
script ran on it, so a page module that no longer reads the real page fails in CI, and a
re-recording shows what the marketplace changed.

The code is in `packages/automation/src/recordings/`; each marketplace's plan is
`<marketplace>/recording-plan.ts`, and its recordings are the JSON files in
`<marketplace>/recordings/`.

## What is recorded

Each marketplace's plan lists its entries (`plans.ts`); each is one recording:

| Entry      | Page                                   | Script                                                     |
| ---------- | -------------------------------------- | ---------------------------------------------------------- |
| `hub`      | A page only the signed-in seller sees  | The adapter's health check                                 |
| `listings` | The seller's shop, closet, or listings | The adapter's `listings` read (imports and drift checks)   |
| `listing`  | One of the seller's listings for sale  | The adapter's read-back of it                              |
| `edit`     | That listing's edit page               | Opening the editor (Poshmark's also reads its private SKU) |
| `sold`     | The seller's sold items                | The adapter's sale check (`orders`)                        |
| `form-*`   | The sell form, one per form shape      | The create's own form filling, without photos, never sent  |

The form shapes are each marketplace's distinct forms: on Depop the 17 department and size-list
shapes ([depop-automation.md](depop-automation.md#live-verification)), on Mercari each size group
with its petite and tall parts and none ([mercari.md](mercari.md)), on Poshmark the size sets,
labelled sizes, one-size categories, kids' sets, display groups, and categories without
subcategories ([poshmark.md](poshmark.md)). `plans.test.ts` checks that each shape's listing is
one the form takes.

## How a recording is made

`npm run recordings:record -- <depop|mercari|poshmark>` (`-- --help` for its options) runs the
marketplace's plan in a Chrome on the Mac where the seller is signed in, started with
`--remote-debugging-port=9333` (`--cdp` names another). Each entry gets a tab of its own, opened
in the background so the seller's own tabs stay in front, and runs through the same session
rules as every automated run (`ScriptSession`: the marketplace's pace before every action, the
page inspection after it), through the page backend of the host the marketplace runs on in
production (the phone runtime's for all three, phone/backend.ts; the runner's for a marketplace
that runs in the cloud), on a recording backend (`recording-backend.ts`) that writes down each
action, the page after it, the data globals and web API answers the script read, and what the
script returned.

**It changes nothing on the marketplace.** Read entries run as reads, which refuse form input and
any step that changes something. Form entries fill a form exactly as a create does, but without
photos, and the recorder refuses any step that would send or change something (the post, the
save); nothing ever clicks a form's submit. As a last guard, the tab blocks any request that
would send a file (`guard.ts`: a photo upload). The page's own other traffic goes through, as when
the seller browses by hand: blocking it broke the pages (Depop's and Mercari's sell forms read
through POSTs, and Depop retried a blocked one hundreds of times), which brought on the
marketplaces' checks.

**It is gentle.** The marketplace's own pace between actions, at most one session every 10
minutes on Depop and Mercari (`.local/recordings/<marketplace>.last` keeps the time), and the
whole session stops at the first check (a CAPTCHA, a bot check such as Cloudflare's "Just a
moment...", a sign-in or verification page), a rate limit, or a server error. Like the phone, it
never passes a check: the seller opens the marketplace in that Chrome and passes it themselves,
then records again.

**A page as it is kept** (`snapshot.ts`): the live document serialized without the
marketplace's own scripts, styles, frames' documents, and SVG drawings; its data scripts kept
inert (JSON, schema.org prices, Depop's App Router payload); form state written into attributes;
and what the page hid marked from its computed style, so a replay shows the same elements as
visible or hidden. Every tag's closing `>` starts a line, so a recording diffs line by line, and a
state that changed little is kept as a patch of the one before it.

**Redaction** (`redact.ts`). Before anything is written, every value the pages name as a person's
(usernames, names, email addresses, phone numbers, street addresses, user ids, by their keys in
data, API answers, and the JSON in the document), the words the plan knows identify the seller
(Depop's username in its slugs, Poshmark's closet name, Mercari's profile ids), the text of the
profile's private parts (buyers' names, addresses, messages) and the plan's own (the seller's
name and profile introduction), and any `--redact` word become
placeholders (`user1`, `Name1`, `user1@example.com`), the same one everywhere, so a slug, a link,
and the data that names it still agree. Credentials (values under token, secret, password,
session, and signature keys; JSON web tokens; long opaque tokens; token query parameters), other
email addresses and phone numbers, and every image address (the seller's photos and avatar) are
replaced too. A recording that still holds anything of the kind (`unredacted`) is not written;
`recording.test.ts` checks every committed one the same way.

## How a recording is used

`recordings.int.test.ts` replays every committed recording (`replay.ts`) in a real headless
Chromium through the same session rules and the backend of the host it was recorded on (the
phone runtime's page functions, or the runner's Playwright), at the marketplace's real
addresses. The host matters: the two read some selectors differently (Playwright's `:text-is`
matches the innermost element with the text, the phone's any element whose whole text it is), and
Mercari's category rows, whose label is inside a `div`, match only on the phone. Every request
the page makes is answered from the recording; nothing reaches a marketplace. Each action must be the next one the recording made (the same
kind, selector, and text) and must work on the recorded page (a click's target there, visible,
enabled, and the only match), after which the page shows the state that action led to. Reads are
answered by the recorded page itself, so a selector, a data key, or a parser that does not fit the
real page fails as it would live, and the page inspection runs on the real page too. The test
passes only when the script acts as it did on the marketplace and gets the same result.

When a script changes on purpose (a new step, another selector), its replay diverges ("the script
clicked X where the recording clicked Y"): re-record the entries it touches
(`--only <entry>`). `replay.int.test.ts` proves the machinery on a local page with scripts of its
own, on both hosts: a changed page fails, a different action is caught, a check stops the replay,
and the tab guard blocks a photo upload while the page's own reads go through.

## When a marketplace changes its pages

`npm run recordings:record -- <marketplace>` rewrites the recordings and prints, for each, what
changed since the committed one (`diff.ts`): the script's result, its first different action,
and per page the kinds of element (by tag, `id`, `data-testid`, `role`, `name`, and `type`) that
are gone or new. Prices, listings, and the sites' generated class names are not flagged. With
`--check` it writes nothing and exits 1 when a page changed: run it before relying on a release
against a marketplace, and when automation starts failing in the field.

## What the fakes still do

The fake sites (`<marketplace>/fake/`) still serve the shared conformance suite and the adapter
tests: posting, revising, ending, relisting, reading back what changed, and every injected fault
(checks, rate limits, server errors, slow and stale pages, validation refusals, redesigned pages),
none of which a read-only recording can show. The fill of each form shape is tested on the
recordings instead: the Mercari and Poshmark fake-site tests that filled every shape were retired
in favour of them (Depop's fake test of a revise from a dress into jeans stays: it checks which
details a revise removes, which a recording of an unsent form cannot).

## Open items

- Recordings cover what the seller's own account shows. A seller with no sales yet records
  empty sold items, and a page only another account state shows (a listing under review, a
  sold listing's page) is still covered by the fakes alone. Depop's `sold` entry (the receipts
  read from the selling hub) is the captain's: the hub page recorded 2026-10-27 with the receipts
  API's empty answer his session gave 2026-10-28, put together because that Chrome then held
  another seller's shop, whose sales are never recorded (the repository is public); re-record it
  (`--only sold`) once the captain's Depop is signed in there again. That seller's receipts were
  read read-only instead ([depop-automation.md](depop-automation.md#live-verification)), and the
  tests use invented receipts in their real shape. An entry about one of the seller's
  listings (`listing`, `edit`) is skipped when the seller has none for sale: the first
  recordings (2026-10-27) have Poshmark's skipped and Depop's shop empty (its `listing` and
  `edit` are from an earlier session of the same day); re-record them once the account has a
  listing for sale on each.
- Recordings are large where the page keeps much data (Poshmark's `__INITIAL_STATE__`, about
  1 MB a page): about 22 MB in all, as text.
- A script that polls the page while the marketplace is still answering (Mercari's brand
  suggestions as they follow the typing) may see in the replay a later answer than it acted on
  live, since a replay shows the page as it was just before the next action. Such an entry is
  recorded without the timing (Mercari's bras form, without a brand).
- Found while recording (2026-10-27), for Mercari's page module: its form picks "No brand / Not
  sure" when Mercari's brand suggestions come later than it waits, and its category rows match
  only on the phone (the runner's Playwright reads `:text-is` differently), so Mercari would fail
  on the runner if it ever ran in the cloud.
- The replay does not run the marketplace's own scripts, so a widget's behaviour (what a picker
  shows after a click) is the recording's, not re-run; a site that changes only behaviour, not
  markup, shows up in a re-recording's changed actions or result.

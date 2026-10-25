# Where docs go

Each feature keeps its documentation in its own file, so parallel branches edit different
files and do not conflict.

| What you are documenting                                                        | Where it goes                                                                                         |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| How a feature works: its design, rules, data, failure handling, open items      | `docs/features/<feature>.md`; add a new file for a new feature and a row to the table in architecture |
| A principle or convention every feature follows (invariants, stack, API, tests) | [architecture.md](architecture.md); keep it short and link to feature docs for details                |
| How to use one package or app (its commands, layout, how to change it)          | That package's or app's own `README.md` (for example `packages/api-contract/README.md`)               |
| Setup and the commands every contributor runs                                   | The repository [README.md](../README.md); a feature's own setup goes in its feature doc               |
| Every configuration key                                                         | `.env.example`, with a comment, in the section of the feature that reads it                           |
| The phases and their order                                                      | [roadmap.md](roadmap.md); task status lives in the task tracker and merged PRs, not in docs           |

Rules:

- A feature PR updates its own feature doc in the same PR. It edits
  [architecture.md](architecture.md) only when it changes a cross-cutting rule, and then fixes
  that rule rather than adding feature detail.
- When a change proves a doc wrong, correct the doc in the same PR.
- Link to another feature's doc instead of repeating it.
- Feature docs keep the same order where it applies: what it is and where the code lives, how it
  works, local development (fakes and switches), then a **Data** section for the feature's
  tables.

Current feature docs are listed in [architecture.md](architecture.md#8-feature-docs).

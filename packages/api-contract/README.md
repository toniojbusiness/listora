# @listora/api-contract

The v1 HTTP contract between the iPhone app and the backend, in OpenAPI 3.1. The contract is
the single source of truth, split by resource so that work on one resource edits only that
resource's files: [`openapi.yaml`](openapi.yaml) is the root, and it `$ref`s the paths in
`paths/` and the components in `components/`. Redocly bundles them into one document, and
everything else in this package is generated from that bundle, committed, and checked for
drift in CI.

| Path                                  | What it is                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `openapi.yaml`                        | The root: info, tags, and one `$ref` per path and per component.                                |
| `paths/<tag>.yaml`                    | The paths whose operations have that tag, keyed by the path itself.                             |
| `components/schemas/<area>.yaml`      | The schemas of one area (`items`, `listings`, ...); `common.yaml` and `errors.yaml` are shared. |
| `components/parameters.yaml`          | Shared parameters (`Idempotency-Key`, pagination, path ids).                                    |
| `components/responses.yaml`           | Shared responses (`DefaultError`, ...).                                                         |
| `bundled/openapi.yaml`                | The bundle (Redocly). Generated; do not edit.                                                   |
| `redocly.yaml`                        | Lint configuration (Redocly `recommended-strict`).                                              |
| `src/index.ts`                        | The TypeScript entry point (`@listora/api-contract`).                                           |
| `src/generated/openapi.ts`            | Generated TypeScript types (openapi-typescript). Do not edit.                                   |
| `src/contract-rules.test.ts`          | Listora's own contract rules (see [Conventions](#conventions)).                                 |
| `swift/`                              | The `ListoraAPI` Swift package the iOS app depends on.                                          |
| `swift/Sources/ListoraAPI/Generated`  | Generated Swift types and client (swift-openapi-generator). Do not edit.                        |
| `swift/openapi-generator-config.yaml` | Swift generator settings.                                                                       |
| `tools/codegen.ts`                    | Bundle, generate, drift check, and Swift test runner.                                           |
| `src/document.ts`                     | Loads the parsed bundle; the API builds its validators from it.                                 |
| `src/open-enum.ts`                    | The one open-enum test, shared by codegen, the contract rules, the API.                         |
| `tools/swift-generator/`              | Pins the exact swift-openapi-generator version (`Package.resolved`).                            |

## Commands

Run these from the repository root.

| Command                     | What it does                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `npm run contract:generate` | Bundles the spec, then regenerates the bundle, the TypeScript types, and the Swift client from it. Commit the result.             |
| `npm run contract:check`    | Lints the spec, regenerates into a temp directory and fails if the committed output differs, then `swift test`s the Swift package |

`npm run check` (and so CI) runs `contract:check`. It needs the Swift toolchain: on macOS it
comes with Xcode, and the Ubuntu CI runner image ships it. The first run builds
swift-openapi-generator (about a minute); SwiftPM build output and caches stay in the
gitignored `.build/` at the repository root.

## Changing the contract

1. Edit the resource's files: its paths in `paths/<tag>.yaml` (the file is named after the
   operations' tag) and its schemas in `components/schemas/<area>.yaml`. A new path or
   component also needs its one `$ref` entry in `openapi.yaml`, in the same position as the
   others of its resource: the generated code follows the root's order. A new resource gets new
   files and a new tag.
2. Inside a file, refer to a component by file and name: `'#/Item'` in the same file,
   `'./common.yaml#/Money'` from another schema file, and
   `'../components/schemas/items.yaml#/Item'` from a paths file. The bundle turns every one into
   `#/components/schemas/Item`.
3. Run `npm run contract:generate`.
4. Run `npm run check`. `src/contract-rules.test.ts` fails when a change breaks a convention
   or the file layout.
5. Commit the spec and the generated code together. When two branches both change the
   contract, the generated files may conflict: resolve the source files, then run
   `npm run contract:generate` again instead of merging generated code by hand.

Adding an optional property, a new operation, or a value to a `Known*` enum (an
[open enum](#open-enums)) is backward compatible. Removing or renaming anything, making a
property required, or adding a value to a closed enum breaks app builds that are already
installed: the generated Swift decoder rejects a closed enum value it does not know. Ship
such changes only together with a plan for installed app versions.

## Using the contract

**Server (TypeScript).** Import types from `@listora/api-contract`. Schemas are exported by
name, operations through `paths` and `operations`, and every closed or `Known*` enum also as
a value array:

```ts
import type { HealthReady, Item, operations } from '@listora/api-contract';
import { IDEMPOTENCY_KEY_HEADER, knownListingStatusValues } from '@listora/api-contract';

type ListItemsQuery = operations['listItems']['parameters']['query'];
app.get<{ Reply: HealthReady }>('/health/ready', handler);
```

The API does not copy any of this by hand: it serves each operation with `contractRoute`,
which takes the method and URL from the contract and validates every request against the
contract's own schemas, loaded from the bundle with `loadContractDocument()` (see the API
conventions in [docs/architecture.md](../../docs/architecture.md#4-api-conventions)).

**iOS (Swift).** The app's `APIClient` package (`apps/ios/Packages/APIClient`) depends on this
package by local path (its package identity is `swift`, the last path component) and on
swift-openapi-urlsession for the transport. `APIClient` builds the generated `Client` with the
signed-in session's bearer token and a timestamp transcoder that accepts the server's
fractional seconds, and converts error responses to `APIFailure`:

```swift
// apps/ios/Packages/APIClient/Package.swift
.package(path: "../../../../packages/api-contract/swift"),
.product(name: "ListoraAPI", package: "swift"),
```

```swift
import APIClient
import ListoraAPI

let api = APIClient(baseURL: apiBaseURL, accessTokens: tokens)
let output = try await api.client.createItem(
    headers: .init(idempotencyKey: UUID().uuidString),
    body: .json(.init(details: .init(title: "Vintage denim jacket")))
)
```

Generated files start with `swiftlint:disable all` and `swift-format-ignore-file`. Exclude
`packages/api-contract/swift/Sources/ListoraAPI/Generated` from any other Swift tooling.

## Conventions

These are checked by `src/contract-rules.test.ts` where a test can check them.

- **Paths.** Resources live under `/v1`. Health probes (`/health/live`, `/health/ready`) are
  not versioned and need no auth. Everything else requires a bearer token, except the OAuth
  browser callback, which is bound to its single-use `state`.
- **Never false success.** Listings, operations, connections, and delist results carry a
  server-rendered `statusDisplay` (`tone` plus `label`, for example
  `Active (confirmed by eBay)` or `Delist failed - Retry`). A `verification` is present only
  when an API read-back or a user confirmation established the state. Clients show these
  values and never compute success themselves. Assisted listings are never labeled
  "confirmed by <marketplace>".
- **Capabilities, not marketplace names.** Clients decide what to offer from
  `availableActions` and `capabilities` (mode `api` or `assisted`), never from the
  marketplace id.
- **Money** is `Money`: integer `amountCents` plus `currency`. Floating-point numbers are
  used only for confidences and measurements.
- **Errors.** Every error body is `ErrorResponse`: `error.code` (machine-readable),
  `error.message` (safe to show), `error.retryable`, `error.requestId`, and optional
  `retryAfterSeconds` and `fieldErrors`. `code` is open: clients handle codes they do not
  know by using `message` and `retryable`. `KnownErrorCode` documents each code's HTTP
  status. Every `/v1` operation declares a `default` error response.
- **Idempotency.** Every POST requires an `Idempotency-Key` header (a UUID per logical
  action, reused on every retry of it). The same key and body replay the first successful
  response for at least 24 hours, the same key with a different body is
  `422 idempotency_key_reused`, and a retry while the first request still runs is
  `409 idempotency_key_in_progress`. A failed request changed nothing and is not stored, so a
  retry with the same key runs it again.
- **Optimistic locking.** `replaceItem` takes `expectedVersion`; a stale version is
  `409 version_conflict`.
- **Pagination.** Unbounded lists take `cursor` and `limit` (1-100, default 25) and return
  `{ data, nextCursor }`. `nextCursor` is absent on the last page. Lists with a small fixed
  bound (one entry per marketplace, an item's photos) return `{ data }`.
- **Absent means no value.** The server omits a property instead of sending `null`, and the
  spec never uses `null`. A full replacement (`PUT`) clears every optional property it leaves
  out.
- **Names.** Properties are camelCase, enum values snake_case, and operation ids camelCase
  verbs (`publishListing`). OAuth callback query parameters keep their standard names.
- **Pricing labels.** `SoldDataSource` lists only real sold data, so an AI estimate or a
  cost floor can never be presented as sold comparables.
- **Sales are orders.** A `Sale` is one marketplace order with one or more `items` (a bundle
  has several). Fees (`FeeLine`, `actual` or `estimated`), `netProceeds`, and `profit` are
  absent until known. An item's own share is in `Item.saleSummary`. Each sold item's delist run
  (`DelistRun`, with one `DelistResult` per other listing) is in `Sale.delistRuns` and
  `Item.delistRun`; an item that sold twice has a `DoubleSale` instead.

### Open enums

A response enum that grows with marketplaces, integrations, or workflows is open: the schema
`X` is `anyOf: [KnownX, string]`, like `ErrorCode`. `KnownX` lists today's values. Request
bodies and query and path parameters use `KnownX` directly, so the server still rejects
values it does not know. Schemas shared by requests and responses (such as `ItemDetails`)
keep `X` for decoding, but requests are held to the same rule: the server validates every
enum value in a request against `KnownX` and rejects an unknown value with
`422 validation_failed` and a `fieldErrors` entry naming the field (for example
`details.condition`). It never stores or interprets a value it does not know. Values only
the server sets, such as `Item.fieldProvenance`, are in responses only, so an app never has
to send back a value it does not know.

The two sides read open enums differently, on purpose:

- **Server (TypeScript): strict.** The server is always the newest party, so it may only
  send values it knows. Code generation (`tools/codegen.ts`) types every `X` as `KnownX`, so
  a typo such as `status: 'actve'` fails `tsc` (see `src/server-types.test.ts`).
- **App (Swift): open.** The generated client decodes any string, so values added after an
  app build never fail decoding.

In Swift an open enum decodes to a struct with `value1` (the `KnownX` case, `nil` for a new
value) and `value2` (the raw string), so a new value never fails decoding:

```swift
switch listing.status.value1 {
case .active?: showActive()
case nil: showGeneric(listing.statusDisplay) // a status added after this build
default: break
}
```

The app treats values it does not know like this:

- **Statuses and states** (`ListingStatus`, `OperationStatus`, `ConnectionStatus`,
  `DelistResultState`, `ItemStatus`, `SaleStatus`): show the server's `statusDisplay`
  (`label` as given) and never treat the value as success.
- **`StatusTone`**: style it like `neutral` and still show the `label`.
- **`ListingAction`**: hide the action.
- **Capability modes** (`IntegrationMode`, `CapabilityMode`, `MarkSoldMode`,
  `ConnectMethod`, `VerifyReadMode`, `ImportListingsMode`): treat like `none` (offer
  nothing that depends on it). `ImageTransportMode`: treat like `user_saves_photos`.
- **`Marketplace`**: show it generically (its raw id and the server's `statusDisplay`), with
  no marketplace-specific branding.
- **`UserTaskKind`**: show the task's `title`, `instructions`, and `deepLink`, and ask the
  user to update the app to complete it.
- **Sources and types** (`SaleDetectionSource`, `OperationKind`, `OperationOriginType`,
  `FeeType`, `SoldDataSource`, `PriceBasis`, `Provenance`, `AnalysisProvenance`): show them
  generically (`FeeType` like `other`); never present an unknown pricing basis as sold data,
  and treat an unknown provenance as not entered by the user.

The remaining response enums are closed on purpose: Listora's own lifecycles (for example
`PhotoStatus`), fixed product sets (`PriceTierName`), values the client itself chooses
(`PhotoRole`, `ItemCondition`), `CurrencyCode`, and `VerificationMethod` (success is
established only by API read-back or user confirmation). `src/contract-rules.test.ts` lists
them, so a new closed enum in a response is a deliberate, reviewed decision.

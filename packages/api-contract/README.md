# @listora/api-contract

The v1 HTTP contract between the iPhone app and the backend. [`openapi.yaml`](openapi.yaml)
(OpenAPI 3.1) is the single source of truth. Everything else in this package is generated
from it, committed, and checked for drift in CI.

| Path                                  | What it is                                                               |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `openapi.yaml`                        | The contract. Edit this file.                                            |
| `redocly.yaml`                        | Lint configuration (Redocly `recommended-strict`).                       |
| `src/index.ts`                        | The TypeScript entry point (`@listora/api-contract`).                    |
| `src/generated/openapi.ts`            | Generated TypeScript types (openapi-typescript). Do not edit.            |
| `src/contract-rules.test.ts`          | Listora's own contract rules (see [Conventions](#conventions)).          |
| `swift/`                              | The `ListoraAPI` Swift package the iOS app depends on.                   |
| `swift/Sources/ListoraAPI/Generated`  | Generated Swift types and client (swift-openapi-generator). Do not edit. |
| `swift/openapi-generator-config.yaml` | Swift generator settings.                                                |
| `tools/codegen.ts`                    | Generate, drift check, and Swift test runner.                            |
| `tools/open-enum.ts`                  | The one open-enum test, shared by codegen and the contract rules.        |
| `tools/swift-generator/`              | Pins the exact swift-openapi-generator version (`Package.resolved`).     |

## Commands

Run these from the repository root.

| Command                     | What it does                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `npm run contract:generate` | Regenerates the TypeScript types and the Swift client from `openapi.yaml`. Commit the result.                                     |
| `npm run contract:check`    | Lints the spec, regenerates into a temp directory and fails if the committed output differs, then `swift test`s the Swift package |

`npm run check` (and so CI) runs `contract:check`. It needs the Swift toolchain: on macOS it
comes with Xcode, and the Ubuntu CI runner image ships it. The first run builds
swift-openapi-generator (about a minute); SwiftPM build output and caches stay in the
gitignored `.build/` at the repository root.

## Changing the contract

1. Edit `openapi.yaml`.
2. Run `npm run contract:generate`.
3. Run `npm run check`. `src/contract-rules.test.ts` fails when a change breaks a convention.
4. Commit the spec and the generated code together.

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

**iOS (Swift).** The app depends on the local package by path, plus a transport. With
XcodeGen (`apps/ios/project.yml`):

```yaml
packages:
  ListoraAPI:
    path: ../../packages/api-contract/swift
  OpenAPIURLSession:
    url: https://github.com/apple/swift-openapi-urlsession
    from: 1.4.0
targets:
  APIClient:
    dependencies:
      - package: ListoraAPI
      - package: OpenAPIURLSession
```

```swift
import ListoraAPI
import OpenAPIURLSession

let client = Client(serverURL: apiBaseURL, transport: URLSessionTransport())
let output = try await client.createItem(
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
  action, reused on every retry of it). The same key and body replay the first response for
  at least 24 hours, the same key with a different body is `422 idempotency_key_reused`, and
  a retry while the first request still runs is `409 idempotency_key_in_progress`.
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
  absent until known. An item's own share is in `Item.saleSummary`.

### Open enums

A response enum that grows with marketplaces, integrations, or workflows is open: the schema
`X` is `anyOf: [KnownX, string]`, like `ErrorCode`. `KnownX` lists today's values. Request
bodies and query and path parameters use `KnownX` directly, so the server still rejects
values it does not know. Schemas shared by requests and responses (such as `ItemDetails`)
keep `X` for decoding, but requests are held to the same rule: the server validates every
enum value in a request against `KnownX` and rejects an unknown value with
`422 validation_failed` and a `fieldErrors` entry naming the field (for example
`details.fieldProvenance.title`). It never stores or interprets a value it does not know.

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

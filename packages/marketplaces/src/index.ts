export { isMarketplace, MARKETPLACE_NAMES, REMOTE_LISTING_STATUSES } from './adapter.ts';
export type {
  AdapterContext,
  AdapterLookup,
  ConnectionRef,
  DesiredListingState,
  Excerpt,
  ListingRef,
  MarketplaceAdapter,
  MarketplaceCapabilities,
  Mode,
  OperationRequest,
  Outcome,
  RemoteListingState,
  RemoteListingStatus,
  UserTaskSpec,
  WriteOperationKind,
} from './adapter.ts';
export {
  desiredStateToJson,
  InvalidDesiredStateError,
  parseDesiredListingState,
} from './desired-state.ts';
export { FakeMarketplaceAdapter } from './fake/fake-adapter.ts';
export type { FakeAdapterOptions } from './fake/fake-adapter.ts';
export { FakeMarketplace } from './fake/fake-marketplace.ts';
export type {
  FakeAction,
  FakeFault,
  FakeListing,
  FakeRequest,
  FaultPicker,
  FaultRule,
} from './fake/fake-marketplace.ts';
export { requestJson } from './http.ts';
export type { HttpResult, JsonRequest } from './http.ts';

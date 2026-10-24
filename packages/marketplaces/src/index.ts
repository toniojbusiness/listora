export { isMarketplace, MARKETPLACE_NAMES, REMOTE_LISTING_STATUSES } from './adapter.ts';
export type {
  AdapterContext,
  AdapterLookup,
  ConnectionRef,
  DesiredListingState,
  Excerpt,
  Health,
  ListingPayload,
  ListingRef,
  MarketplaceAdapter,
  MarketplaceCapabilities,
  Mode,
  OperationRequest,
  Outcome,
  RemoteListingState,
  RemoteListingStatus,
  UserTaskSpec,
  ValidationIssue,
  WriteOperationKind,
} from './adapter.ts';
export { AssistedAdapter } from './assisted/assisted-adapter.ts';
export type {
  AssistedAdapterOptions,
  AssistedCapabilityOverrides,
  AssistedListingPayload,
} from './assisted/assisted-adapter.ts';
export {
  createDepopAssistedAdapter,
  createMercariAdapter,
  createPoshmarkAdapter,
} from './assisted/marketplaces.ts';
export {
  CAPABILITY_FOR_KIND,
  checkCapabilities,
  operationMode,
  unsupportedMessage,
} from './capabilities.ts';
export type { OperationMode } from './capabilities.ts';
export { ConnectionAwareAdapter } from './connection-aware.ts';
export type { ConnectionAwareAdapterOptions } from './connection-aware.ts';
export {
  CONTENT_KINDS,
  desiredStateForContent,
  InvalidListingContentError,
  isContentKind,
  ITEM_CONDITIONS,
  listingContentToJson,
  parseListingContent,
  photosInOrder,
} from './content.ts';
export type {
  ContentKind,
  ItemCondition,
  ItemSnapshot,
  ListingAspect,
  ListingContent,
  ListingPhoto,
  ListingVariant,
  Measurement,
} from './content.ts';
export {
  desiredStateToJson,
  InvalidDesiredStateError,
  parseDesiredListingState,
} from './desired-state.ts';
export { FakeMarketplaceAdapter } from './fake/fake-adapter.ts';
export type {
  FakeAdapterOptions,
  FakeCapabilityOverrides,
  FakeListingPayload,
} from './fake/fake-adapter.ts';
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
export { AdapterRegistryError, createAdapterRegistry } from './registry.ts';
export type { AdapterRegistry } from './registry.ts';

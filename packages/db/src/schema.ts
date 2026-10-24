/**
 * Kysely table types for the Listora schema. Maintained by hand next to the SQL migrations:
 * a migration that changes a table updates its interface here in the same change.
 * `schema.int.test.ts` fails when a table or column exists on one side only.
 *
 * Column type conventions (see `createDatabase` for the matching value parsers):
 * - `bigint` columns (money in cents, counters) read as `number`; values beyond
 *   Number.MAX_SAFE_INTEGER throw instead of losing precision.
 * - `date` columns read as `YYYY-MM-DD` strings, never as local-time `Date`s.
 * - `timestamptz` columns read as `Date`.
 * - `jsonb` columns are written with `jsonb(value)` (see json.ts) and read as parsed JSON.
 * - Columns the database maintains (`id`, `created_at`, `updated_at`, `version`) are optional
 *   or forbidden on insert and update.
 */
import type { ColumnType, Generated, RawBuilder } from 'kysely';

import type { CurrencyCode } from '@listora/shared';

import type { JsonArray, JsonObject, JsonValue } from './json.ts';
import type {
  AiProvider,
  AnalysisStatus,
  AnalysisTier,
  AuditActorKind,
  AuthProvider,
  ConnectionMode,
  ConnectionStatus,
  DelistRunListingSource,
  DelistRunStatus,
  FeeKind,
  FeeSource,
  InboundEventResult,
  InboundEventSource,
  ItemStatus,
  ListingStatus,
  Marketplace,
  MembershipRole,
  OperationKind,
  OperationOrigin,
  OperationStatus,
  PhotoRole,
  Plan,
  PricingSource,
  SaleDetectionSource,
  SaleStatus,
  SubscriptionSource,
  SubscriptionStatus,
  SuccessEvidence,
  UserTaskKind,
  UserTaskStatus,
  UserTaskUrgency,
} from './values.ts';

/** Written and maintained only by the database (defaults and triggers). */
type DatabaseManaged<T> = ColumnType<T, never, never>;
/** Defaults to now() on insert and is never changed afterwards. */
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type UpdatedAt = DatabaseManaged<Date>;
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
/** A `date` column, as `YYYY-MM-DD`. */
type DateString = string;
type Id = Generated<string>;
type Nullable<T> = ColumnType<T | null, T | null | undefined, T | null>;
/** `text[] not null default '{}'`. */
type TextArray = Generated<string[]>;

type Jsonb<T extends JsonValue> = ColumnType<T, RawBuilder<T>, RawBuilder<T>>;
type DefaultedJsonb<T extends JsonValue> = ColumnType<T, RawBuilder<T> | undefined, RawBuilder<T>>;
type NullableJsonb<T extends JsonValue> = ColumnType<
  T | null,
  RawBuilder<T> | null | undefined,
  RawBuilder<T> | null
>;

// Tenancy -------------------------------------------------------------------------------------

export interface AccountTable {
  id: Id;
  name: string;
  sku_prefix: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface AppUserTable {
  id: Id;
  auth_provider: AuthProvider;
  auth_subject: string;
  email: Nullable<string>;
  display_name: Nullable<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface MembershipTable {
  account_id: string;
  user_id: string;
  role: MembershipRole;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** Created by a trigger with each account; advanced only by `allocateSku`. */
export interface SkuSequenceTable {
  account_id: string;
  next_number: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

// Inventory -----------------------------------------------------------------------------------

export interface StorageLocationTable {
  id: Id;
  account_id: string;
  code: string;
  label: Nullable<string>;
  parent_id: Nullable<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface InventoryItemTable {
  id: Id;
  account_id: string;
  /** Allocated by `allocateSku`; never chosen by callers. */
  sku: string;
  status: Generated<ItemStatus>;
  title: Nullable<string>;
  brand: Nullable<string>;
  product_name: Nullable<string>;
  style_number: Nullable<string>;
  rn_number: Nullable<string>;
  upc: Nullable<string>;
  department: Nullable<string>;
  category: Nullable<string>;
  size_label: Nullable<string>;
  size_system: Nullable<string>;
  colors: TextArray;
  pattern: Nullable<string>;
  materials: TextArray;
  condition: Nullable<string>;
  condition_notes: Nullable<string>;
  flaws: TextArray;
  keywords: TextArray;
  description: Nullable<string>;
  measurements: DefaultedJsonb<JsonObject>;
  attributes: DefaultedJsonb<JsonObject>;
  currency: Generated<CurrencyCode>;
  list_price_cents: Nullable<number>;
  floor_price_cents: Nullable<number>;
  cost_cents: Nullable<number>;
  purchase_date: Nullable<DateString>;
  purchase_source: Nullable<string>;
  storage_location_id: Nullable<string>;
  quantity: Generated<number>;
  accepted_analysis_id: Nullable<string>;
  field_provenance: DefaultedJsonb<JsonObject>;
  /** Optimistic lock: bumped by a trigger on every update; filter updates on it. */
  version: DatabaseManaged<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface PhotoTable {
  id: Id;
  account_id: string;
  item_id: string;
  position: number;
  role: PhotoRole;
  storage_key: string;
  width: Nullable<number>;
  height: Nullable<number>;
  sha256: Nullable<string>;
  phash: Nullable<string>;
  derivatives: DefaultedJsonb<JsonObject>;
  ocr_lines: DefaultedJsonb<JsonArray>;
  barcodes: DefaultedJsonb<JsonArray>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

// AI ------------------------------------------------------------------------------------------

export interface AiAnalysisTable {
  id: Id;
  account_id: string;
  item_id: string;
  photo_set_hash: string;
  tier: AnalysisTier;
  model: string;
  status: Generated<AnalysisStatus>;
  output: NullableJsonb<JsonObject>;
  error_code: Nullable<string>;
  error_message: Nullable<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface AiUsageEventTable {
  id: Id;
  account_id: string;
  user_id: Nullable<string>;
  item_id: Nullable<string>;
  purpose: string;
  provider: AiProvider;
  model: string;
  input_tokens: Generated<number>;
  output_tokens: Generated<number>;
  cache_read_tokens: Generated<number>;
  cache_write_tokens: Generated<number>;
  images: Generated<number>;
  web_searches: Generated<number>;
  cost_micros: number;
  price_table_version: string;
  latency_ms: Nullable<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface AiUsageDailyTable {
  account_id: string;
  usage_date: DateString;
  calls: Generated<number>;
  input_tokens: Generated<number>;
  output_tokens: Generated<number>;
  cache_read_tokens: Generated<number>;
  cache_write_tokens: Generated<number>;
  images: Generated<number>;
  web_searches: Generated<number>;
  cost_micros: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

// Marketplaces --------------------------------------------------------------------------------

export interface MarketplaceConnectionTable {
  id: Id;
  account_id: string;
  marketplace: Marketplace;
  mode: ConnectionMode;
  external_user_id: Nullable<string>;
  display_name: Nullable<string>;
  token_ciphertext: Nullable<Buffer>;
  access_expires_at: NullableTimestamp;
  refresh_expires_at: NullableTimestamp;
  scopes: TextArray;
  status: Generated<ConnectionStatus>;
  last_ok_at: NullableTimestamp;
  last_error: Nullable<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface MarketplaceListingTable {
  id: Id;
  account_id: string;
  item_id: string;
  marketplace: Marketplace;
  connection_id: Nullable<string>;
  status: Generated<ListingStatus>;
  external_listing_id: Nullable<string>;
  external_sku: Nullable<string>;
  external_url: Nullable<string>;
  title: Nullable<string>;
  description: Nullable<string>;
  currency: Generated<CurrencyCode>;
  price_cents: Nullable<number>;
  category_ref: Nullable<string>;
  aspects: DefaultedJsonb<JsonObject>;
  listed_at: NullableTimestamp;
  ended_at: NullableTimestamp;
  last_verified_at: NullableTimestamp;
  remote_snapshot: NullableJsonb<JsonObject>;
  desired_version: Generated<number>;
  applied_version: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface MarketplaceOperationTable {
  id: Id;
  account_id: string;
  listing_id: string;
  kind: OperationKind;
  idempotency_key: string;
  desired: Jsonb<JsonObject>;
  status: Generated<OperationStatus>;
  success_evidence: Nullable<SuccessEvidence>;
  attempts: Generated<number>;
  next_attempt_at: NullableTimestamp;
  error_code: Nullable<string>;
  error_message: Nullable<string>;
  origin: OperationOrigin;
  delist_run_id: Nullable<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** Append-only: the database rejects updates and deletes. */
export interface OperationEventTable {
  id: Id;
  account_id: string;
  operation_id: string;
  from_status: ColumnType<OperationStatus | null, OperationStatus | null | undefined, never>;
  to_status: ColumnType<OperationStatus, OperationStatus, never>;
  attempt: ColumnType<number, number | undefined, never>;
  error_code: ColumnType<string | null, string | null | undefined, never>;
  detail: ColumnType<JsonObject, RawBuilder<JsonObject> | undefined, never>;
  created_at: CreatedAt;
}

// Sales and delisting -------------------------------------------------------------------------

export interface InboundEventTable {
  id: Id;
  account_id: string;
  source: InboundEventSource;
  provider_event_id: string;
  signature_ok: Nullable<boolean>;
  payload: Jsonb<JsonValue>;
  processed_at: NullableTimestamp;
  result: Nullable<InboundEventResult>;
  error_message: Nullable<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface SaleTable {
  id: Id;
  account_id: string;
  item_id: string;
  listing_id: Nullable<string>;
  marketplace: Marketplace;
  external_order_id: Nullable<string>;
  sold_at: Timestamp;
  currency: Generated<CurrencyCode>;
  sale_price_cents: number;
  shipping_charged_cents: Generated<number>;
  detection_source: SaleDetectionSource;
  inbound_event_id: Nullable<string>;
  status: Generated<SaleStatus>;
  ship_by: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface DelistRunTable {
  id: Id;
  account_id: string;
  sale_id: string;
  item_id: string;
  status: Generated<DelistRunStatus>;
  realerted_at: NullableTimestamp;
  escalated_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** View: per-listing results of a delist run (its operations and user tasks). */
export interface DelistRunListingView {
  account_id: DatabaseManaged<string>;
  delist_run_id: DatabaseManaged<string>;
  listing_id: DatabaseManaged<string | null>;
  source: DatabaseManaged<DelistRunListingSource>;
  source_id: DatabaseManaged<string>;
  status: DatabaseManaged<OperationStatus | UserTaskStatus>;
  updated_at: DatabaseManaged<Date>;
}

export interface UserTaskTable {
  id: Id;
  account_id: string;
  kind: UserTaskKind;
  item_id: Nullable<string>;
  listing_id: Nullable<string>;
  operation_id: Nullable<string>;
  delist_run_id: Nullable<string>;
  urgency: Generated<UserTaskUrgency>;
  deep_link: Nullable<string>;
  payload: DefaultedJsonb<JsonObject>;
  status: Generated<UserTaskStatus>;
  completed_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface FeeLineTable {
  id: Id;
  account_id: string;
  sale_id: string;
  kind: FeeKind;
  currency: Generated<CurrencyCode>;
  amount_cents: number;
  source: FeeSource;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ExpenseTable {
  id: Id;
  account_id: string;
  incurred_on: DateString;
  category: string;
  description: Nullable<string>;
  currency: Generated<CurrencyCode>;
  amount_cents: number;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

// Pricing -------------------------------------------------------------------------------------

export interface PricingSnapshotTable {
  id: Id;
  account_id: string;
  item_id: string;
  source: PricingSource;
  payload: Jsonb<JsonObject>;
  fetched_at: Generated<Date>;
  expires_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

// Billing -------------------------------------------------------------------------------------

export interface SubscriptionTable {
  id: Id;
  account_id: string;
  source: SubscriptionSource;
  external_id: string;
  plan: Plan;
  status: SubscriptionStatus;
  current_period_start: Timestamp;
  current_period_end: Timestamp;
  cancel_at_period_end: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface EntitlementTable {
  id: Id;
  account_id: string;
  plan: Plan;
  subscription_id: Nullable<string>;
  active_from: Timestamp;
  active_until: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface UsageCounterTable {
  account_id: string;
  metric: string;
  period_start: DateString;
  period_end: DateString;
  used: Generated<number>;
  quota: Nullable<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

// History -------------------------------------------------------------------------------------

/** Append-only: the database rejects updates and deletes. */
export interface AuditLogTable {
  id: Id;
  account_id: string;
  item_id: ColumnType<string | null, string | null | undefined, never>;
  actor_kind: ColumnType<AuditActorKind, AuditActorKind, never>;
  actor_user_id: ColumnType<string | null, string | null | undefined, never>;
  action: ColumnType<string, string, never>;
  changes: ColumnType<JsonObject, RawBuilder<JsonObject> | undefined, never>;
  created_at: CreatedAt;
}

/** Every table and view in the schema, keyed by name. */
export interface Database {
  account: AccountTable;
  app_user: AppUserTable;
  membership: MembershipTable;
  sku_sequence: SkuSequenceTable;
  storage_location: StorageLocationTable;
  inventory_item: InventoryItemTable;
  photo: PhotoTable;
  ai_analysis: AiAnalysisTable;
  ai_usage_event: AiUsageEventTable;
  ai_usage_daily: AiUsageDailyTable;
  marketplace_connection: MarketplaceConnectionTable;
  marketplace_listing: MarketplaceListingTable;
  marketplace_operation: MarketplaceOperationTable;
  operation_event: OperationEventTable;
  inbound_event: InboundEventTable;
  sale: SaleTable;
  delist_run: DelistRunTable;
  delist_run_listing: DelistRunListingView;
  user_task: UserTaskTable;
  fee_line: FeeLineTable;
  expense: ExpenseTable;
  pricing_snapshot: PricingSnapshotTable;
  subscription: SubscriptionTable;
  entitlement: EntitlementTable;
  usage_counter: UsageCounterTable;
  audit_log: AuditLogTable;
}

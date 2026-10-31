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
  AccountDeletionGrantOutcome,
  ConnectionDeletionReason,
  ConnectionDeletionRevocation,
  DeletionRecordKind,
  AiControlAction,
  AiProvider,
  AiUsageOutcome,
  AnalysisStatus,
  AnalysisTier,
  AuditActorKind,
  AutomationRunHost,
  AutomationRunOutcome,
  AutomationRunPurpose,
  AuthProvider,
  BackgroundRead,
  ChallengeKind,
  ConnectionAuthorizationStatus,
  ConnectionMode,
  ConnectionStatus,
  DelistRunListingSource,
  DevicePlatform,
  ExecutionLocation,
  DelistRunStatus,
  FeeKind,
  FeeSource,
  HistoryOnlyReason,
  InboundEventResult,
  InboundEventSource,
  ItemStatus,
  LabelCarrier,
  ItemScanBasis,
  ItemScanCall,
  ItemScanConfidence,
  ItemScanDecision,
  ScanResearchKind,
  LabelOrderState,
  LabelReadStatus,
  ListingImportMatch,
  ListingImportOutcome,
  ListingImportStatus,
  ListingStatus,
  Marketplace,
  MembershipRole,
  OperationKind,
  OperationOrigin,
  OperationStatus,
  ImageContentType,
  OfferAction,
  OfferCheckOutcome,
  OfferResponseStatus,
  OfferStatus,
  PackMatch,
  PhoneWorkPurpose,
  PhotoRole,
  PhotoStatus,
  Plan,
  PreArchiveItemStatus,
  PricingSource,
  PushEnvironment,
  SaleCheckHealth,
  SaleCheckOutcome,
  SaleCheckReason,
  SaleCheckRunKind,
  SaleDetectionSource,
  SaleLabelSource,
  RelistDecision,
  SaleStatus,
  SessionCheckStatus,
  SubscriptionSource,
  SubscriptionStatus,
  SuccessEvidence,
  UploadFileStatus,
  UserTaskKind,
  UserTaskStatus,
  UserTaskUrgency,
  RefreshCadence,
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
  /** The business the seller sells as, from Settings; null until they enter one. */
  business_name: Nullable<string>;
  /**
   * When the account was created from an invite (docs/features/invites.md); null for an account
   * created directly, and only those may invite.
   */
  invited_at: NullableTimestamp;
  /**
   * Test mode (docs/features/test-mode.md): the account sees and runs every marketplace feature
   * that is built, not only those that passed live. Only the deployment owner's account turns
   * it on.
   */
  test_mode: Generated<boolean>;
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

/** An invite of the account (docs/features/invites.md): only its code's SHA-256 is kept. */
export interface AccountInviteTable {
  id: Id;
  account_id: string;
  code_sha256: Buffer;
  /** The code's last four characters, to tell invites apart. */
  code_hint: string;
  label: Nullable<string>;
  /** Null: the invite never expires. Only an unredeemed invite expires. */
  expires_at: NullableTimestamp;
  /** The invitee's email, lowercase, once they redeemed it. */
  claimed_email: Nullable<string>;
  claimed_at: NullableTimestamp;
  email_changes: Generated<number>;
  invitee_user_id: Nullable<string>;
  /** The invitee's own account, from their first sign-in. */
  invitee_account_id: Nullable<string>;
  accepted_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
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
  /** The status before the item was archived; set exactly when `status` is `archived`. */
  pre_archive_status: Nullable<PreArchiveItemStatus>;
  /** The item's own refresh cadence, over the account's; null: the account's. */
  refresh_cadence: Nullable<RefreshCadence>;
  /** Hours between refreshes; only with `custom`. */
  refresh_custom_hours: Nullable<number>;
  /** The haul the item is part of (docs/features/hauls.md); its cost is then its share. */
  haul_id: Nullable<string>;
  /** When it joined the haul, with `haul_id`: its place for the haul's leftover cents. */
  haul_joined_at: NullableTimestamp;
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
  status: Generated<PhotoStatus>;
  failure_reason: Nullable<string>;
  processed_at: NullableTimestamp;
}

export interface UploadSessionTable {
  id: Id;
  account_id: string;
  expires_at: Timestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface UploadFileTable {
  id: Id;
  account_id: string;
  session_id: string;
  position: number;
  content_type: ImageContentType;
  byte_size: number;
  sha256: string;
  storage_key: string;
  status: Generated<UploadFileStatus>;
  uploaded_at: NullableTimestamp;
  attached_at: NullableTimestamp;
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
  requested_by_user_id: Nullable<string>;
  /** Set exactly for `premium` analyses: the standard analysis this one escalates. */
  escalated_from_analysis_id: Nullable<string>;
  attempts: Generated<number>;
  /** Set exactly for `failed` analyses. */
  error_retryable: Nullable<boolean>;
  /** When the analysis succeeded or failed. */
  completed_at: NullableTimestamp;
}

/**
 * The seller's answer to one of the marketplace pre-fill's questions, for the item details it was
 * given for (docs/features/marketplace-prefill.md).
 */
export interface ItemPrefillAnswerTable {
  account_id: string;
  item_id: string;
  /** `kidsGender`, or `<marketplace>.category` / `<marketplace>.size`. */
  key: string;
  value: string;
  /** A hash of the item's category, department, and size when the seller answered. */
  basis: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** The AI's pick for one pre-fill question, so it is asked once; `value` null: no pick. */
export interface ItemPrefillPickTable {
  account_id: string;
  item_id: string;
  decision_hash: string;
  key: string;
  value: Nullable<string>;
  confidence: number;
  created_at: CreatedAt;
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
  tier: AnalysisTier;
  outcome: AiUsageOutcome;
  /** Set exactly when `outcome` is `failed`. */
  error_code: Nullable<string>;
  batch: Generated<boolean>;
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
  failed_calls: Generated<number>;
}

/**
 * The global AI kill switch: exactly one row, created by the migration and only updated.
 * A platform setting, so it has no `account_id`.
 */
export interface AiKillSwitchTable {
  singleton: DatabaseManaged<boolean>;
  engaged: ColumnType<boolean, never, boolean>;
  /** Who made the last change and why; both null until the first change. */
  changed_by: ColumnType<string | null, never, string>;
  reason: ColumnType<string | null, never, string>;
  created_at: DatabaseManaged<Date>;
  updated_at: UpdatedAt;
}

/** An account blocked from AI by an operator; unblocking deletes the row. */
export interface AiAccountBlockTable {
  account_id: ColumnType<string, string, never>;
  blocked_by: ColumnType<string, string, never>;
  reason: ColumnType<string, string, never>;
  created_at: CreatedAt;
}

/** Append-only: the database rejects updates and deletes. */
export interface AiControlAuditTable {
  id: Id;
  action: ColumnType<AiControlAction, AiControlAction, never>;
  /** Null for the kill switch. */
  account_id: ColumnType<string | null, string | null | undefined, never>;
  actor: ColumnType<string, string, never>;
  reason: ColumnType<string, string, never>;
  created_at: CreatedAt;
}

// Marketplaces --------------------------------------------------------------------------------

export interface MarketplaceConnectionTable {
  id: Id;
  account_id: string;
  marketplace: Marketplace;
  mode: ConnectionMode;
  /**
   * The seller whose account the connection holds: the marketplace's immutable id of an API
   * connection, the signed-in seller's handle an automation connection's session check read
   * (docs/features/marketplace-linking.md#the-shop-a-connection-holds); `null` until known.
   */
  external_user_id: Nullable<string>;
  display_name: Nullable<string>;
  /** OAuth tokens (api) or the browser session (automation), encrypted; never a password. */
  token_ciphertext: Nullable<Buffer>;
  access_expires_at: NullableTimestamp;
  refresh_expires_at: NullableTimestamp;
  /** The order poll has seen every order last changed before this time. */
  orders_polled_through: NullableTimestamp;
  scopes: TextArray;
  status: Generated<ConnectionStatus>;
  last_ok_at: NullableTimestamp;
  /** The latest problem's user-readable message; with its code and time, or none of them. */
  last_error: Nullable<string>;
  last_error_code: Nullable<string>;
  last_error_at: NullableTimestamp;
  /** When the marketplace issued the current grant; older revocation notices change nothing. */
  granted_at: NullableTimestamp;
  /**
   * Bumped by every write of an automation connection's browser session (the session vault),
   * so a runner holding an older session never overwrites a newer one.
   */
  credential_version: Generated<number>;
  /** When the latest health check or use of the connection finished, whatever it found. */
  last_checked_at: NullableTimestamp;
  /** When the seller last asked for a check; pending while later than `last_checked_at`. */
  check_requested_at: NullableTimestamp;
  /** Where its automated steps run: the cloud runner, or the phone (phone-execution.md). */
  runs_on: Generated<ExecutionLocation>;
  /** The device that runs them on the phone: the one that linked the session. */
  phone_device_id: Nullable<string>;
  /** Listora only reads the account: every write refuses (docs/features/read-only.md). */
  read_only: Generated<boolean>;
  /**
   * Read only only because the account's marketplace was when the connection was made: it stays
   * so until the session check names the shop, then follows that shop (read-only.md).
   */
  read_only_carried: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/**
 * A marketplace that is read only on the account: kept by triggers while its connection is read
 * only and after the connection is deleted, so every new connection of it starts read only
 * (docs/features/read-only.md#unlinking-and-relinking). Removed only when the setting is turned off.
 */
export interface MarketplaceReadOnlyTable {
  account_id: string;
  marketplace: Marketplace;
  created_at: CreatedAt;
}

/**
 * A seller an account's connection held while read only by the owner's setting: kept by
 * triggers, so a connection of the account that comes to hold it again is read only again, until
 * the owner turns Read only off with it linked (docs/features/read-only.md#the-shop-not-the-row).
 */
export interface ReadOnlySellerTable {
  account_id: string;
  marketplace: Marketplace;
  seller_id: string;
  created_at: CreatedAt;
}

/**
 * A shop Listora only ever reads, whoever links it: every connection that holds it is read only
 * and stays so. Named by its seller only, as `seller_digest(seller_id)` (SHA-256, hex), so a
 * real shop's handle is never in the repository. Only a migration changes it.
 */
export interface ProtectedSellerTable {
  id: Id;
  marketplace: Marketplace;
  seller_digest: string;
  reason: string;
  created_at: CreatedAt;
}

/** One attempt to connect a marketplace account over OAuth (the `state` is stored hashed). */
export interface ConnectionAuthorizationTable {
  id: Id;
  account_id: string;
  user_id: string;
  marketplace: Marketplace;
  state_sha256: Buffer;
  /** When the callback claimed the attempt (its state is single-use). */
  callback_at: NullableTimestamp;
  status: Generated<ConnectionAuthorizationStatus>;
  connection_id: Nullable<string>;
  failure_code: Nullable<string>;
  failure_message: Nullable<string>;
  expires_at: Timestamp;
  completed_at: NullableTimestamp;
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
  /** Item specifics, in order: `[{ name, values }]` (the contract's `ListingAspect`). */
  aspects: DefaultedJsonb<JsonArray>;
  /** The marketplace's condition when it differs from the item's (an `ItemCondition`). */
  condition: Nullable<string>;
  /** Without the `#`; only Depop shows them. */
  hashtags: Generated<string[]>;
  listed_at: NullableTimestamp;
  ended_at: NullableTimestamp;
  last_verified_at: NullableTimestamp;
  remote_snapshot: NullableJsonb<JsonObject>;
  desired_version: Generated<number>;
  applied_version: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  /** The newest revision seen of the marketplace listing `external_listing_id` names. */
  remote_revision: Nullable<number>;
  /** The newest listing id the marketplace returned that no read-back has confirmed yet. */
  pending_external_listing_id: Nullable<string>;
  /** The newest revision seen of the marketplace listing `pending_external_listing_id` names. */
  pending_remote_revision: Nullable<number>;
  /** When the user last confirmed the listing's state (an assisted listing); never a read-back. */
  user_confirmed_at: NullableTimestamp;
  /**
   * When the shop it was on was unlinked: it is from that previous shop, so no later link adopts
   * it (docs/features/marketplace-linking.md#relinking-another-shop). Only without a connection.
   */
  shop_unlinked_at: NullableTimestamp;
}

export interface MarketplaceOperationTable {
  id: Id;
  account_id: string;
  /** Null once the listing's item was deleted; the operation is then kept by `deleted_listing_id`. */
  listing_id: ColumnType<string | null, string, string | null>;
  /** The listing as it was when its item was deleted (`deleted_listing`); null until then. */
  deleted_listing_id: ColumnType<string | null, never, string>;
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
  /** The listing content a create, revise, or relist publishes; null for every other kind. */
  content: NullableJsonb<JsonObject>;
}

/**
 * What a deleted item was (docs/features/items.md, Deleting an item): its id is the item's. Kept
 * with its listings' operations for the owner's and operators' history; no seller view reads it.
 */
export interface DeletedItemTable {
  id: string;
  account_id: string;
  sku: string;
  title: Nullable<string>;
  deleted_at: CreatedAt;
  /** The seller deleted it, or it went when its marketplace was unlinked (only its import made it). */
  reason: Generated<HistoryOnlyReason>;
}

/**
 * What a listing of a deleted item, or of an unlinked marketplace, was; its id is the listing's.
 * An unlinked listing's item may still be in Listora (it was listed elsewhere too).
 */
export interface DeletedListingTable {
  id: string;
  account_id: string;
  item_id: string;
  marketplace: Marketplace;
  /** Its status when it was deleted (a live listing stays up on its marketplace). */
  status: ListingStatus;
  external_listing_id: Nullable<string>;
  deleted_at: CreatedAt;
  reason: Generated<HistoryOnlyReason>;
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
  marketplace: Marketplace;
  provider_event_id: string;
  signature_ok: Nullable<boolean>;
  payload: Jsonb<JsonValue>;
  processed_at: NullableTimestamp;
  result: Nullable<InboundEventResult>;
  error_message: Nullable<string>;
  /** The marketplace user the event is about (eBay userId), for deleting their data. */
  external_user_id: Nullable<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** One marketplace order; the items it sold are its `sale_item` rows. */
export interface SaleTable {
  id: Id;
  account_id: string;
  marketplace: Marketplace;
  external_order_id: Nullable<string>;
  sold_at: Timestamp;
  currency: Generated<CurrencyCode>;
  shipping_charged_cents: Generated<number>;
  detection_source: SaleDetectionSource;
  inbound_event_id: Nullable<string>;
  status: Generated<SaleStatus>;
  ship_by: NullableTimestamp;
  confirmed_at: NullableTimestamp;
  shipped_at: NullableTimestamp;
  canceled_at: NullableTimestamp;
  returned_at: NullableTimestamp;
  /** What the seller paid to ship outside the payout; null until known. */
  shipping_cost_cents: Nullable<number>;
  /** The sale check that saw it, while that check's record is kept. */
  sale_check_run_id: Nullable<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** One item sold in an order; `marketplace` must equal the sale's. */
export interface SaleItemTable {
  id: Id;
  account_id: string;
  sale_id: string;
  marketplace: Marketplace;
  item_id: string;
  listing_id: Nullable<string>;
  currency: Generated<CurrencyCode>;
  sale_price_cents: number;
  /** Set once the sale is canceled or returned: `pending` until the seller decides. */
  relist_decision: Nullable<RelistDecision>;
  relist_decided_at: NullableTimestamp;
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
  /** The sale the task is about (the later sale of a double sale). */
  sale_id: Nullable<string>;
  /** The offer an `answer_offer` task is about (docs/features/offers.md). */
  offer_id: Nullable<string>;
}

export interface FeeLineTable {
  id: Id;
  account_id: string;
  sale_id: string;
  sale_item_id: Nullable<string>;
  kind: FeeKind;
  currency: Generated<CurrencyCode>;
  amount_cents: number;
  source: FeeSource;
  description: Nullable<string>;
  /** The fee table an estimated line was computed with. */
  fee_table_version: Nullable<string>;
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

// API ---------------------------------------------------------------------------------------

/**
 * The stored first successful response to a POST, keyed by its `Idempotency-Key`. Written once
 * in the transaction of the change it reports; deleted in batches by later POSTs once it
 * expires, or with its account.
 */
export interface IdempotencyRecordTable {
  account_id: string;
  /** The Idempotency-Key's SHA-256 (hex); the key itself in records stored before sealing. */
  key: string;
  operation_id: string;
  request_hash: string;
  response_status: number;
  /** Null once sealed: only records stored before `response_ciphertext` hold the response. */
  response_body: NullableJsonb<JsonValue>;
  /** The response sealed under a key derived from the Idempotency-Key (apps/api/src/idempotency.ts). */
  response_ciphertext: Nullable<Buffer>;
  created_at: CreatedAt;
  expires_at: Timestamp;
}

/**
 * An identity whose account was deleted: its tokens issued at or before `deleted_at` are
 * refused. The subject is stored only as its SHA-256.
 */
export interface DeletedIdentityTable {
  auth_provider: AuthProvider;
  auth_subject_sha256: Buffer;
  /**
   * Defaults to now; moved forward when the provider confirms the user is gone, and when the
   * identity deletes a later account.
   */
  deleted_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

/**
 * The tombstone of a committed account deletion whose `account_deletion` job has not finished
 * (deleting the person at the identity provider, revoking marketplace grants).
 */
export interface AccountDeletionTable {
  id: Id;
  auth_provider: AuthProvider;
  auth_subject_sha256: Buffer;
  /** The provider's admin API name for the user (Cognito's username); null for dev. */
  provider_username: Nullable<string>;
  requested_at: CreatedAt;
  identity_deleted_at: NullableTimestamp;
  attempts: Generated<number>;
  /** The deleted account; null when a member left an account that stays (or before T-33). */
  account_id: Nullable<string>;
  /** The deleted user; null for tombstones written before T-33. */
  user_id: Nullable<string>;
  /** Key prefixes that hold only the deleted account's objects. */
  storage_prefixes: TextArray;
  /** When every stored object of the deletion was deleted and checked gone. */
  objects_deleted_at: NullableTimestamp;
}

/** A stored object an account deletion still has to delete. */
export interface AccountDeletionObjectTable {
  deletion_id: string;
  storage_key: string;
}

/** A deleted account's marketplace grant; the encrypted tokens stay only while it is pending. */
export interface AccountDeletionGrantTable {
  deletion_id: string;
  connection_id: string;
  marketplace: Marketplace;
  token_ciphertext: Nullable<Buffer>;
  outcome: Generated<AccountDeletionGrantOutcome>;
}

/**
 * The tombstone of a marketplace connection whose data was deleted and whose
 * `connection_deletion` job has not finished (revoking the grant, deleting stored objects).
 */
export interface ConnectionDeletionTable {
  id: Id;
  connection_id: string;
  marketplace: Marketplace;
  reason: ConnectionDeletionReason;
  /** The grant's encrypted tokens, only while its revocation is pending. */
  token_ciphertext: Nullable<Buffer>;
  revocation: ConnectionDeletionRevocation;
  requested_at: CreatedAt;
  attempts: Generated<number>;
}

/** A stored object a connection deletion still has to delete. */
export interface ConnectionDeletionObjectTable {
  deletion_id: string;
  storage_key: string;
}

/** The completion record of a finished deletion; it holds no personal data. */
export interface DeletionRecordTable {
  id: string;
  kind: DeletionRecordKind;
  reason: string;
  marketplace: Nullable<Marketplace>;
  requested_at: Timestamp;
  completed_at: CreatedAt;
  summary: DefaultedJsonb<JsonObject>;
}

// Browser automation --------------------------------------------------------------------------

/** One browser session the runner opened for a connection (docs/features/automation.md). */
export interface AutomationRunTable {
  id: Id;
  account_id: string;
  connection_id: string;
  marketplace: Marketplace;
  purpose: AutomationRunPurpose;
  script: string;
  /** The operation an `operation` run is a step of, when it has one. */
  operation_id: Nullable<string>;
  started_at: Generated<Date>;
  finished_at: NullableTimestamp;
  outcome: Nullable<AutomationRunOutcome>;
  challenge_kind: Nullable<ChallengeKind>;
  failed_step: Nullable<string>;
  error_code: Nullable<string>;
  /** A private storage key of the redacted screenshot taken when the run failed. */
  screenshot_key: Nullable<string>;
  /** Where it ran: the browser runner, or the phone. */
  host: Generated<AutomationRunHost>;
  /** The steps it ran, in order, and how long each took (`AutomationRunStep`). */
  steps: NullableJsonb<JsonArray>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** When the runner next checks an automation connection for sales. */
export interface SaleCheckScheduleTable {
  account_id: string;
  connection_id: string;
  marketplace: Marketplace;
  next_check_at: Timestamp;
  next_reason: SaleCheckReason;
  last_started_at: NullableTimestamp;
  last_finished_at: NullableTimestamp;
  last_outcome: Nullable<SaleCheckOutcome>;
  checked_through: NullableTimestamp;
  last_succeeded_at: NullableTimestamp;
  failures_in_a_row: Generated<number>;
  last_error_code: Nullable<string>;
  /** User-readable, names the marketplace. */
  last_error_message: Nullable<string>;
  /** Whether the connection's sale checks work (docs/features/activity.md). */
  health: Generated<SaleCheckHealth>;
  unhealthy_since: NullableTimestamp;
  /** When the seller was told about the current problem. */
  alerted_at: NullableTimestamp;
  /**
   * Where the connection's sales history ends (docs/features/sales.md): a sale that sold before
   * it is recorded only (detection source `history`), one after it is acted on.
   */
  history_until: Generated<Date>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/**
 * One sale check, or one read of the seller's sold history: where and when it ran, what it read,
 * and how it ended (docs/features/activity.md).
 */
export interface SaleCheckRunTable {
  id: Id;
  account_id: string;
  connection_id: string;
  marketplace: Marketplace;
  kind: SaleCheckRunKind;
  /** Why a scheduled check ran; null for a history read. */
  reason: Nullable<SaleCheckReason>;
  host: AutomationRunHost;
  started_at: Generated<Date>;
  finished_at: NullableTimestamp;
  outcome: Nullable<SaleCheckOutcome>;
  since: NullableTimestamp;
  orders_seen: Nullable<number>;
  items_seen: Nullable<number>;
  new_orders: Nullable<number>;
  newest_sold_at: NullableTimestamp;
  oldest_sold_at: NullableTimestamp;
  /** What it read, at most 100 orders (`SaleCheckOrderRecord`); never buyer data. */
  orders: DefaultedJsonb<JsonArray>;
  error_code: Nullable<string>;
  error_message: Nullable<string>;
  automation_run_id: Nullable<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/**
 * The check that an automation connection's newest linked session works, which the app waits
 * for before it shows the marketplace as linked (one row per connection).
 */
export interface SessionCheckTable {
  account_id: string;
  connection_id: string;
  marketplace: Marketplace;
  /** The link this check is for; a relink sets a new one. */
  check_id: Generated<string>;
  status: Generated<SessionCheckStatus>;
  attempts: Generated<number>;
  failure_code: Nullable<string>;
  /** User-readable and names the marketplace. */
  failure_message: Nullable<string>;
  requested_at: Generated<Date>;
  finished_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

// Phone execution (docs/features/phone-execution.md) ----------------------------------------

/** A device the seller runs the app on: where pushes go, and which phone runs a connection. */
export interface AppDeviceTable {
  id: Id;
  account_id: string;
  /** Made by the app and kept in its Keychain; the API names devices by it. */
  installation_id: string;
  user_id: string;
  name: string;
  platform: DevicePlatform;
  app_version: Nullable<string>;
  /** The version of phone calls its runtime speaks. */
  runtime_version: Nullable<number>;
  /** APNs device token (hex), with its APNs environment, or neither. */
  push_token: Nullable<string>;
  push_environment: Nullable<PushEnvironment>;
  last_seen_at: Generated<Date>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** Work handed to the phone: an automated operation step or a session check, and its run. */
export interface PhoneWorkTable {
  id: Id;
  account_id: string;
  connection_id: string;
  marketplace: Marketplace;
  purpose: PhoneWorkPurpose;
  operation_id: Nullable<string>;
  check_id: Nullable<string>;
  priority: Generated<number>;
  waiting_since: Generated<Date>;
  due_at: Generated<Date>;
  notified_at: NullableTimestamp;
  claimed_at: NullableTimestamp;
  lease_expires_at: NullableTimestamp;
  /** What the claim decided (null while it waits). */
  step: NullableJsonb<JsonObject>;
  /** The script calls the phone answered so far, in order. */
  transcript: DefaultedJsonb<JsonArray>;
  /** The call the phone runs now. */
  pending_call: NullableJsonb<JsonObject>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  /** The import a `listing_import` reads the next page of. */
  import_id: Nullable<string>;
  /** The seller's answer to an offer that an `offer_response` sends. */
  offer_response_id: Nullable<string>;
}

// Imports -------------------------------------------------------------------------------------

/** One import of the seller's listings on a marketplace (docs/features/imports.md). */
export interface ListingImportTable {
  id: Id;
  account_id: string;
  connection_id: string;
  marketplace: Marketplace;
  status: Generated<ListingImportStatus>;
  host: AutomationRunHost;
  /** The next page to read; null for the first page. */
  cursor: Nullable<string>;
  pages_read: Generated<number>;
  listings_read: Generated<number>;
  imported: Generated<number>;
  merged: Generated<number>;
  already_listed: Generated<number>;
  needs_you: Generated<number>;
  failed: Generated<number>;
  /** Why reading stopped before the last page; user-readable. */
  error_code: Nullable<string>;
  error_message: Nullable<string>;
  read_at: NullableTimestamp;
  finished_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** One listing an import read, and how it settled. */
export interface ListingImportEntryTable {
  id: Id;
  account_id: string;
  import_id: string;
  marketplace: Marketplace;
  external_listing_id: string;
  /** The listing as read (`ListedListing`). */
  listing: Jsonb<JsonObject>;
  outcome: Generated<ListingImportOutcome>;
  match: Nullable<ListingImportMatch>;
  item_id: Nullable<string>;
  listing_id: Nullable<string>;
  /** For `needs_you`: `[{ itemId, reason }]`, best first. */
  candidates: DefaultedJsonb<JsonArray>;
  error_message: Nullable<string>;
  /** The seller said it is an item of its own: imported without matching it again. */
  new_item: Generated<boolean>;
  settled_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

// Today ---------------------------------------------------------------------------------------

/** The morning summary notification's setting, one per account (docs/features/today.md). */
/** How often an account's live listings are refreshed (docs/features/listing-refresh.md). */
export interface ListingRefreshSettingTable {
  account_id: string;
  cadence: Generated<RefreshCadence>;
  /** Hours between refreshes; only with `custom`. */
  custom_hours: Nullable<number>;
  /** The quiet window, in minutes after midnight in `time_zone`; both or neither. */
  quiet_start: Nullable<number>;
  quiet_end: Nullable<number>;
  /** An IANA time zone name, which the quiet window needs. */
  time_zone: Nullable<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface TodaySummarySettingTable {
  account_id: string;
  enabled: Generated<boolean>;
  /** Wall-clock time in `time_zone`, as `HH:MM:SS` (whole minutes). */
  local_time: ColumnType<string, string | undefined, string>;
  /** An IANA time zone name; the summary is never sent without one. */
  time_zone: Nullable<string>;
  /** The local date of the latest summary sent. */
  last_sent_on: Nullable<DateString>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

// Description style ---------------------------------------------------------------------------

/** The seller's own description style, one per account (docs/features/description-style.md). */
export interface DescriptionStyleTable {
  account_id: string;
  /** How to write the Depop draft, replacing Listora's default style. */
  depop: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

// Sale emails ---------------------------------------------------------------------------------

/** An account's forwarding address and email sale settings (docs/features/email-sales.md). */
export interface SaleEmailInboxTable {
  account_id: string;
  /** The private part of `sales+<token>@<inbound domain>`. */
  address_token: string;
  ask_before_delist: Generated<boolean>;
  last_email_at: NullableTimestamp;
  /** The latest marketplace email that passed DKIM and SPF. */
  last_verified_email_at: NullableTimestamp;
  last_sale_email_at: NullableTimestamp;
  confirmation_provider: Nullable<string>;
  confirmation_code: Nullable<string>;
  confirmation_url: Nullable<string>;
  confirmation_received_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

// Hauls ---------------------------------------------------------------------------------------

/** Items bought together for one price (docs/features/hauls.md). */
export interface HaulTable {
  id: Id;
  account_id: string;
  total_cents: number;
  currency: Generated<CurrencyCode>;
  /** How many items the haul had; never fewer than the items in it. */
  item_count: number;
  purchase_date: Nullable<DateString>;
  purchase_source: Nullable<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

// Thrift scan ---------------------------------------------------------------------------------

/** One trip to a store, scanning items to buy (docs/features/thrift-scan.md). */
export interface SourcingRunTable {
  id: Id;
  account_id: string;
  created_by_user_id: Nullable<string>;
  place: Nullable<string>;
  started_at: Generated<Date>;
  ended_at: NullableTimestamp;
  /** Every scan of the run and those kept; kept after skipped scans are deleted. */
  scan_count: Generated<number>;
  kept_count: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** One item scanned at the store: the AI's read and the call. Its images are never stored. */
export interface ItemScanTable {
  id: Id;
  account_id: string;
  run_id: string;
  created_by_user_id: Nullable<string>;
  image_sha256: string;
  image_count: number;
  /** The AI's read (`ThriftScan` of @listora/analysis). */
  read: Jsonb<JsonObject>;
  call: ItemScanCall;
  confidence: ItemScanConfidence;
  basis: ItemScanBasis;
  /** The call as the app showed it (the API's `ScanCall`). */
  call_detail: Jsonb<JsonObject>;
  decision: Generated<ItemScanDecision>;
  /** The item a kept scan became; null once that item is deleted. */
  item_id: Nullable<string>;
  model: string;
  ai_attempts: number;
  cost_micros: number;
  read_ms: number;
  /** The web research that came in after the read; null until the app asked for it. */
  research: NullableJsonb<JsonObject>;
  research_ms: Nullable<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** What the web said about a brand and item, kept so a repeat scan needs no search. */
export interface ScanResearchTable {
  account_id: string;
  kind: ScanResearchKind;
  key: string;
  research: Jsonb<JsonObject>;
  model: string;
  cost_micros: number;
  created_at: CreatedAt;
}

// Batch listing -------------------------------------------------------------------------------

/** A haul photographed in one session (docs/features/batch.md). */
export interface ItemBatchTable {
  id: Id;
  account_id: string;
  created_by_user_id: Nullable<string>;
  /** The seller's measured interaction: all three set, or none until the app reports them. */
  active_ms: Nullable<number>;
  waiting_ms: Nullable<number>;
  taps: Nullable<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** One item of a batch, at its place in the haul. */
export interface ItemBatchItemTable {
  account_id: string;
  batch_id: string;
  item_id: string;
  position: number;
  /** When the app had attached every photo (`photo_count` of them). */
  submitted_at: NullableTimestamp;
  photo_count: Nullable<number>;
  /** Why the worker did not start the analysis; all three set, or none. */
  start_error_code: Nullable<string>;
  start_error_message: Nullable<string>;
  start_error_retryable: Nullable<boolean>;
  active_ms: Nullable<number>;
  waiting_ms: Nullable<number>;
  taps: Nullable<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

// Offers --------------------------------------------------------------------------------------

/** An offer a buyer made on one of the seller's listings (docs/features/offers.md). */
export interface MarketplaceOfferTable {
  id: Id;
  account_id: string;
  connection_id: string;
  marketplace: Marketplace;
  external_offer_id: string;
  external_listing_id: Nullable<string>;
  listing_id: Nullable<string>;
  item_id: Nullable<string>;
  listing_title: Nullable<string>;
  status: Generated<OfferStatus>;
  currency: Generated<CurrencyCode>;
  amount_cents: number;
  list_price_cents: Nullable<number>;
  buyer_name: Nullable<string>;
  details: DefaultedJsonb<JsonObject>;
  offer_url: Nullable<string>;
  made_at: NullableTimestamp;
  expires_at: NullableTimestamp;
  first_seen_at: Generated<Date>;
  last_seen_at: ColumnType<Date, Date | string | undefined, Date | string>;
  closed_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** The seller's answer to an offer: sent once, succeeded only with a read-back. */
export interface OfferResponseTable {
  id: Id;
  account_id: string;
  offer_id: string;
  action: OfferAction;
  currency: Generated<CurrencyCode>;
  offer_amount_cents: number;
  counter_cents: Nullable<number>;
  net_cents: number;
  idempotency_key: string;
  status: Generated<OfferResponseStatus>;
  attempts: Generated<number>;
  sent: Generated<boolean>;
  success_evidence: Nullable<'read_back'>;
  error_code: Nullable<string>;
  error_message: Nullable<string>;
  retryable: Generated<boolean>;
  finished_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** When a connection's offers were last asked for and read. */
export interface OfferCheckTable {
  account_id: string;
  connection_id: string;
  marketplace: Marketplace;
  requested_at: NullableTimestamp;
  last_started_at: NullableTimestamp;
  last_finished_at: NullableTimestamp;
  last_succeeded_at: NullableTimestamp;
  last_outcome: Nullable<OfferCheckOutcome>;
  last_error_code: Nullable<string>;
  last_error_message: Nullable<string>;
  offers_seen: Nullable<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

// Background read health ----------------------------------------------------------------------

/**
 * Whether one connection's background read works, one per connection and read
 * (docs/features/read-health.md): the owner's alert and admin view, never the seller's.
 */
export interface BackgroundReadHealthTable {
  account_id: string;
  connection_id: string;
  marketplace: Marketplace;
  read: BackgroundRead;
  last_succeeded_at: NullableTimestamp;
  last_failed_at: NullableTimestamp;
  failures_in_a_row: Generated<number>;
  failing_since: NullableTimestamp;
  last_error_code: Nullable<string>;
  last_error_step: Nullable<string>;
  last_error_detail: Nullable<string>;
  owner_alerted_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/**
 * One run of a feature that has not passed live, in an account's Test mode
 * (docs/features/test-mode.md): the owner's log, cited as evidence when it is marked verified.
 */
export interface FeatureTestRunTable {
  id: Id;
  account_id: string;
  marketplace: Marketplace;
  feature: string;
  outcome: 'passed' | 'failed';
  subject_id: string;
  error_code: Nullable<string>;
  detail: Nullable<string>;
  created_at: CreatedAt;
}

// Pack check ----------------------------------------------------------------------------------

/** Whether Pack check is on, one per account (docs/features/pack-check.md); off by default. */
export interface PackCheckSettingTable {
  account_id: string;
  enabled: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** A sale's shipping label and buyer's first name, from its order page or the seller's scan. */
export interface SaleLabelTable {
  account_id: string;
  sale_id: string;
  /** Canonical (`canonicalTracking` in @listora/pack-check); set with `source` and `carrier`. */
  tracking_number: Nullable<string>;
  carrier: Nullable<LabelCarrier>;
  source: Nullable<SaleLabelSource>;
  buyer_first_name: Nullable<string>;
  /** The last read of the order page; set with `read_at`. */
  read_status: Nullable<LabelReadStatus>;
  read_error: Nullable<string>;
  read_at: NullableTimestamp;
  /** What the order page last said of the order; `null` when it doesn't say. */
  order_state: Nullable<LabelOrderState>;
  /** When the marketplace's label expires, as its page shows it. */
  label_expires_at: NullableTimestamp;
  /** The label's file on the marketplace's own site (https), when its page names one. */
  label_file_url: Nullable<string>;
  /** The label Listora last printed for the order (canonical); set with `printed_at`. */
  printed_tracking_number: Nullable<string>;
  printed_at: NullableTimestamp;
  /** How many times Listora printed `printed_tracking_number`. */
  print_count: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** A packed order: one per sale, and one per label (the duplicate-print guard). */
export interface SalePackTable {
  account_id: string;
  sale_id: string;
  /** Empty once the sale is past buyer data retention (docs/features/privacy.md#retention). */
  tracking_number: Nullable<string>;
  matched_by: PackMatch;
  /** Set exactly when `matched_by` is `sticker`. */
  sticker_sku: Nullable<string>;
  packed_by_user_id: Nullable<string>;
  packed_at: Generated<Date>;
  /** The package photo's storage key; set with `photo_added_at`. */
  photo_key: Nullable<string>;
  photo_added_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** Every table and view in the schema, keyed by name. */
export interface Database {
  account: AccountTable;
  app_user: AppUserTable;
  membership: MembershipTable;
  account_invite: AccountInviteTable;
  sku_sequence: SkuSequenceTable;
  storage_location: StorageLocationTable;
  inventory_item: InventoryItemTable;
  photo: PhotoTable;
  upload_session: UploadSessionTable;
  upload_file: UploadFileTable;
  ai_analysis: AiAnalysisTable;
  item_prefill_answer: ItemPrefillAnswerTable;
  item_prefill_pick: ItemPrefillPickTable;
  ai_usage_event: AiUsageEventTable;
  ai_usage_daily: AiUsageDailyTable;
  ai_kill_switch: AiKillSwitchTable;
  ai_account_block: AiAccountBlockTable;
  ai_control_audit: AiControlAuditTable;
  marketplace_connection: MarketplaceConnectionTable;
  marketplace_read_only: MarketplaceReadOnlyTable;
  read_only_seller: ReadOnlySellerTable;
  protected_seller: ProtectedSellerTable;
  connection_authorization: ConnectionAuthorizationTable;
  marketplace_listing: MarketplaceListingTable;
  marketplace_operation: MarketplaceOperationTable;
  deleted_item: DeletedItemTable;
  deleted_listing: DeletedListingTable;
  operation_event: OperationEventTable;
  inbound_event: InboundEventTable;
  sale: SaleTable;
  sale_item: SaleItemTable;
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
  idempotency_record: IdempotencyRecordTable;
  deleted_identity: DeletedIdentityTable;
  account_deletion: AccountDeletionTable;
  account_deletion_grant: AccountDeletionGrantTable;
  account_deletion_object: AccountDeletionObjectTable;
  connection_deletion: ConnectionDeletionTable;
  connection_deletion_object: ConnectionDeletionObjectTable;
  deletion_record: DeletionRecordTable;
  automation_run: AutomationRunTable;
  sale_check_schedule: SaleCheckScheduleTable;
  sale_check_run: SaleCheckRunTable;
  session_check: SessionCheckTable;
  app_device: AppDeviceTable;
  phone_work: PhoneWorkTable;
  listing_import: ListingImportTable;
  listing_import_entry: ListingImportEntryTable;
  today_summary_setting: TodaySummarySettingTable;
  listing_refresh_setting: ListingRefreshSettingTable;
  description_style: DescriptionStyleTable;
  sale_email_inbox: SaleEmailInboxTable;
  item_batch: ItemBatchTable;
  pack_check_setting: PackCheckSettingTable;
  sale_label: SaleLabelTable;
  sale_pack: SalePackTable;
  item_batch_item: ItemBatchItemTable;
  marketplace_offer: MarketplaceOfferTable;
  offer_response: OfferResponseTable;
  offer_check: OfferCheckTable;
  background_read_health: BackgroundReadHealthTable;
  feature_test_run: FeatureTestRunTable;
  haul: HaulTable;
  sourcing_run: SourcingRunTable;
  item_scan: ItemScanTable;
  scan_research: ScanResearchTable;
}

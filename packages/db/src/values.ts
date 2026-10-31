/**
 * Allowed values of the text columns that the schema constrains with a CHECK. Each list must
 * match its CHECK in the migrations exactly; `schema.int.test.ts` compares them against the
 * live database. To add a value, write a migration that changes the CHECK and update the list
 * here in the same change.
 */
import type { CurrencyCode } from '@listora/shared';

/** Currencies the `currency_code` domain accepts; matches CurrencyCode in @listora/shared. */
export const CURRENCY_CODES = ['USD'] as const satisfies readonly CurrencyCode[];

export const MARKETPLACES = ['ebay', 'depop', 'poshmark', 'mercari'] as const;
export type Marketplace = (typeof MARKETPLACES)[number];

export const AUTH_PROVIDERS = ['dev', 'cognito'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export const MEMBERSHIP_ROLES = ['owner', 'admin', 'member'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const ITEM_STATUSES = [
  'draft',
  'ready',
  'listed',
  'sold_pending_delist',
  'sold',
  'shipped',
  'archived',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** `inventory_item.pre_archive_status`: every item status but `archived`. */
export const PRE_ARCHIVE_ITEM_STATUSES = [
  'draft',
  'ready',
  'listed',
  'sold_pending_delist',
  'sold',
  'shipped',
] as const satisfies readonly Exclude<ItemStatus, 'archived'>[];
export type PreArchiveItemStatus = (typeof PRE_ARCHIVE_ITEM_STATUSES)[number];

export const PHOTO_ROLES = ['front', 'back', 'tag', 'flaw', 'detail'] as const;
export type PhotoRole = (typeof PHOTO_ROLES)[number];

export const PHOTO_STATUSES = ['processing', 'ready', 'failed'] as const;
export type PhotoStatus = (typeof PHOTO_STATUSES)[number];

/** Upload formats the image pipeline can decode. */
export const IMAGE_CONTENT_TYPES = ['image/jpeg'] as const;
export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];

export const UPLOAD_FILE_STATUSES = ['pending', 'uploaded', 'attached'] as const;
export type UploadFileStatus = (typeof UPLOAD_FILE_STATUSES)[number];

export const ANALYSIS_TIERS = ['standard', 'premium'] as const;
export type AnalysisTier = (typeof ANALYSIS_TIERS)[number];

export const ANALYSIS_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const AI_PROVIDERS = ['fake', 'anthropic'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_USAGE_OUTCOMES = ['succeeded', 'failed'] as const;
export type AiUsageOutcome = (typeof AI_USAGE_OUTCOMES)[number];

/** Operator changes to the AI controls, as recorded in `ai_control_audit`. */
export const AI_CONTROL_ACTIONS = [
  'kill_switch_on',
  'kill_switch_off',
  'account_block_on',
  'account_block_off',
] as const;
export type AiControlAction = (typeof AI_CONTROL_ACTIONS)[number];

/**
 * How a connection reaches the marketplace: its official API, browser automation in the
 * seller's own session (decision D1), or not at all (assisted: the user does each step).
 */
export const CONNECTION_MODES = ['api', 'assisted', 'automation'] as const;
export type ConnectionMode = (typeof CONNECTION_MODES)[number];

export const CONNECTION_STATUSES = ['connected', 'degraded', 'reauth_required', 'revoked'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** `connection_authorization.status`; a pending attempt past its expiry reads as expired. */
export const CONNECTION_AUTHORIZATION_STATUSES = ['pending', 'completed', 'failed'] as const;
export type ConnectionAuthorizationStatus = (typeof CONNECTION_AUTHORIZATION_STATUSES)[number];

export const LISTING_STATUSES = [
  'draft',
  'queued',
  'publishing',
  'active',
  'ending',
  'ended',
  'sold',
  'error',
  'unknown',
  'needs_user_action',
] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const OPERATION_KINDS = [
  'create',
  'revise',
  'price',
  'end',
  'relist',
  'mark_sold',
  'verify',
  'refresh',
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/** `listing_refresh_setting.cadence` and `inventory_item.refresh_cadence` (listing-refresh.md). */
export const REFRESH_CADENCES = [
  'off',
  'every_72_hours',
  'daily',
  'every_few_days',
  'weekly',
  'custom',
] as const;
export type RefreshCadence = (typeof REFRESH_CADENCES)[number];

export const OPERATION_STATUSES = [
  'queued',
  'running',
  'retrying',
  'verifying',
  'succeeded',
  'failed',
  'needs_user_action',
  'canceled',
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

/** How an operation's success was established; `succeeded` requires one of these. */
export const SUCCESS_EVIDENCE = ['read_back', 'user_confirmation'] as const;
export type SuccessEvidence = (typeof SUCCESS_EVIDENCE)[number];

export const OPERATION_ORIGINS = ['user', 'auto_delist', 'reprice_rule', 'auto_refresh'] as const;
export type OperationOrigin = (typeof OPERATION_ORIGINS)[number];

export const USER_TASK_KINDS = [
  'list_manually',
  'delist_manually',
  'edit_manually',
  'confirm_sale',
  'reconnect',
  'review_match',
  'resolve_double_sale',
  'answer_offer',
] as const;
export type UserTaskKind = (typeof USER_TASK_KINDS)[number];

export const USER_TASK_URGENCIES = ['normal', 'high', 'urgent'] as const;
export type UserTaskUrgency = (typeof USER_TASK_URGENCIES)[number];

export const USER_TASK_STATUSES = ['open', 'done', 'dismissed'] as const;
export type UserTaskStatus = (typeof USER_TASK_STATUSES)[number];

export const INBOUND_EVENT_SOURCES = [
  'ebay_webhook',
  'depop_webhook',
  'poll',
  'email',
  'manual',
] as const;
export type InboundEventSource = (typeof INBOUND_EVENT_SOURCES)[number];

export const INBOUND_EVENT_RESULTS = ['processed', 'ignored', 'failed'] as const;
export type InboundEventResult = (typeof INBOUND_EVENT_RESULTS)[number];

/**
 * `history`: from the seller's sales history, sold before the connection's history ends: recorded
 * only.
 */
export const SALE_DETECTION_SOURCES = ['webhook', 'poll', 'email', 'manual', 'history'] as const;
export type SaleDetectionSource = (typeof SALE_DETECTION_SOURCES)[number];

export const SALE_STATUSES = ['detected', 'confirmed', 'shipped', 'canceled', 'returned'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

/** After a canceled or returned sale: whether the seller relisted the item (`sale_item`). */
export const RELIST_DECISIONS = ['pending', 'relisted', 'declined'] as const;
export type RelistDecision = (typeof RELIST_DECISIONS)[number];

export const DELIST_RUN_STATUSES = ['in_progress', 'completed', 'attention_needed'] as const;
export type DelistRunStatus = (typeof DELIST_RUN_STATUSES)[number];

export const FEE_KINDS = [
  'marketplace',
  'payment',
  'shipping_label',
  'promotion',
  'tax',
  'other',
] as const;
export type FeeKind = (typeof FEE_KINDS)[number];

export const FEE_SOURCES = ['actual', 'estimated'] as const;
export type FeeSource = (typeof FEE_SOURCES)[number];

export const PRICING_SOURCES = [
  'depop_inspiration',
  'ebay_mi',
  'own_history',
  'ai_estimate',
] as const;
export type PricingSource = (typeof PRICING_SOURCES)[number];

export const SUBSCRIPTION_SOURCES = ['stripe', 'app_store'] as const;
export type SubscriptionSource = (typeof SUBSCRIPTION_SOURCES)[number];

export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'grace_period',
  'past_due',
  'canceled',
  'expired',
  'revoked',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const PLANS = ['starter', 'seller', 'pro', 'business'] as const;
export type Plan = (typeof PLANS)[number];

export const AUDIT_ACTOR_KINDS = ['user', 'system', 'ai', 'marketplace'] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

export const DELIST_RUN_LISTING_SOURCES = ['operation', 'user_task'] as const;
export type DelistRunListingSource = (typeof DELIST_RUN_LISTING_SOURCES)[number];

/**
 * A deleted account's marketplace grant: still to be revoked, confirmed revoked, or given up on
 * (the seller must remove Listora in the marketplace's settings).
 */
export const ACCOUNT_DELETION_GRANT_OUTCOMES = ['pending', 'revoked', 'manual'] as const;
export type AccountDeletionGrantOutcome = (typeof ACCOUNT_DELETION_GRANT_OUTCOMES)[number];

/**
 * Why a listing (`deleted_listing`) or item (`deleted_item`) is kept as history only: its item
 * was deleted, or its marketplace was unlinked (docs/features/privacy.md).
 */
export const HISTORY_ONLY_REASONS = ['item_deleted', 'unlinked'] as const;
export type HistoryOnlyReason = (typeof HISTORY_ONLY_REASONS)[number];

/**
 * Why a connection's data was deleted: the seller unlinked it, its access stayed revoked past
 * the retention period, or the marketplace ended Listora's access (an operator's purge).
 */
export const CONNECTION_DELETION_REASONS = [
  'unlinked',
  'revoked',
  'marketplace_terminated',
] as const;
export type ConnectionDeletionReason = (typeof CONNECTION_DELETION_REASONS)[number];

/** A deleted connection's grant: nothing to revoke, still to revoke, confirmed, or given up. */
export const CONNECTION_DELETION_REVOCATIONS = ['none', 'pending', 'revoked', 'manual'] as const;
export type ConnectionDeletionRevocation = (typeof CONNECTION_DELETION_REVOCATIONS)[number];

/** What a `deletion_record` completed: an account, a connection, or an eBay user's data. */
export const DELETION_RECORD_KINDS = ['account', 'connection', 'ebay_user'] as const;
export type DeletionRecordKind = (typeof DELETION_RECORD_KINDS)[number];

/** What a browser automation run was for (`automation_run.purpose`). */
export const AUTOMATION_RUN_PURPOSES = [
  'operation',
  'sale_check',
  'health',
  'import',
  'label_read',
  'offer_check',
  'offer_response',
] as const;
export type AutomationRunPurpose = (typeof AUTOMATION_RUN_PURPOSES)[number];

/** Where an automation connection's automated steps run (docs/features/phone-execution.md). */
export const EXECUTION_LOCATIONS = ['cloud', 'phone'] as const;
export type ExecutionLocation = (typeof EXECUTION_LOCATIONS)[number];

/** Which host ran an automation run. */
export const AUTOMATION_RUN_HOSTS = ['runner', 'phone'] as const;
export type AutomationRunHost = (typeof AUTOMATION_RUN_HOSTS)[number];

export const PHONE_WORK_PURPOSES = [
  'operation',
  'session_check',
  'sale_check',
  'sale_history',
  'listing_import',
  'label_read',
  'offer_check',
  'offer_response',
] as const;
export type PhoneWorkPurpose = (typeof PHONE_WORK_PURPOSES)[number];

/** `listing_import.status` (docs/features/imports.md). */
export const LISTING_IMPORT_STATUSES = ['reading', 'importing', 'finished'] as const;
export type ListingImportStatus = (typeof LISTING_IMPORT_STATUSES)[number];

/** `listing_import_entry.outcome`: how one listing an import read settled. */
export const LISTING_IMPORT_OUTCOMES = [
  'pending',
  'imported',
  'merged',
  'already_listed',
  'needs_you',
  'skipped',
  'failed',
] as const;
export type ListingImportOutcome = (typeof LISTING_IMPORT_OUTCOMES)[number];

/** `listing_import_entry.match`: how a merged listing found its item. */
export const LISTING_IMPORT_MATCHES = ['sku', 'title_photos', 'seller'] as const;
export type ListingImportMatch = (typeof LISTING_IMPORT_MATCHES)[number];

export const DEVICE_PLATFORMS = ['ios'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const PUSH_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type PushEnvironment = (typeof PUSH_ENVIRONMENTS)[number];

export const AUTOMATION_RUN_OUTCOMES = [
  'succeeded',
  'failed',
  'timeout',
  'challenge',
  'canceled',
] as const;
export type AutomationRunOutcome = (typeof AUTOMATION_RUN_OUTCOMES)[number];

/**
 * A page browser automation must never pass (docs/architecture.md section 1): it stops at once
 * and the user takes over. `session_rejected`: the marketplace logged the session out or asks
 * for a password; `unexpected_page`: the session landed outside the marketplace's own site.
 */
export const CHALLENGE_KINDS = [
  'captcha',
  'bot_check',
  'login_challenge',
  'session_rejected',
  'unexpected_page',
] as const;
export type ChallengeKind = (typeof CHALLENGE_KINDS)[number];

/** Why a connection's next sale check is due when it is (`sale_check_schedule.next_reason`). */
export const SALE_CHECK_REASONS = [
  'scheduled',
  'email',
  'retry',
  'linked',
  'offer',
  'sync',
] as const;
export type SaleCheckReason = (typeof SALE_CHECK_REASONS)[number];

export const SALE_CHECK_OUTCOMES = ['succeeded', 'failed', 'challenge'] as const;
export type SaleCheckOutcome = (typeof SALE_CHECK_OUTCOMES)[number];

/**
 * What a recorded sale check did (`sale_check_run.kind`): a `scheduled` check hands new sold
 * orders to the sale intake; a `history` read only reads the seller's sold history.
 */
export const SALE_CHECK_RUN_KINDS = ['scheduled', 'history'] as const;
export type SaleCheckRunKind = (typeof SALE_CHECK_RUN_KINDS)[number];

/** Whether a connection's sale checks work (`sale_check_schedule.health`). */
export const SALE_CHECK_HEALTHS = ['healthy', 'failing', 'overdue'] as const;
export type SaleCheckHealth = (typeof SALE_CHECK_HEALTHS)[number];

/** Whether a newly linked session works (`session_check.status`). */
export const SESSION_CHECK_STATUSES = ['pending', 'passed', 'failed'] as const;
export type SessionCheckStatus = (typeof SESSION_CHECK_STATUSES)[number];

/** Where a sale's shipping label came from (`sale_label.source`, docs/features/pack-check.md). */
export const SALE_LABEL_SOURCES = ['marketplace', 'scan'] as const;
export type SaleLabelSource = (typeof SALE_LABEL_SOURCES)[number];

/** The carrier a label's tracking number names (`sale_label.carrier`). */
export const LABEL_CARRIERS = ['usps', 'ups', 'fedex', 'dhl', 'other'] as const;
export type LabelCarrier = (typeof LABEL_CARRIERS)[number];

/** The last read of a sale's order page for its label (`sale_label.read_status`). */
export const LABEL_READ_STATUSES = ['read', 'no_label', 'not_found', 'failed'] as const;
export type LabelReadStatus = (typeof LABEL_READ_STATUSES)[number];

/**
 * What a marketplace's order page last said of the order (`sale_label.order_state`): waiting to
 * ship, or shipped or canceled there (delivered and refunded included).
 */
export const LABEL_ORDER_STATES = ['to_ship', 'shipped', 'canceled'] as const;
export type LabelOrderState = (typeof LABEL_ORDER_STATES)[number];

/** How a packed order's label was known to be its own (`sale_pack.matched_by`). */
export const PACK_MATCHES = ['sticker', 'label', 'photo'] as const;
export type PackMatch = (typeof PACK_MATCHES)[number];

/** `marketplace_offer.status` (docs/features/offers.md). */
export const OFFER_STATUSES = ['pending', 'accepted', 'declined', 'countered', 'closed'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/** `offer_response.action`: the seller's answer to an offer. */
export const OFFER_ACTIONS = ['accept', 'decline', 'counter'] as const;
export type OfferAction = (typeof OFFER_ACTIONS)[number];

/** `offer_response.status`: sent once, succeeded only with a read-back. */
export const OFFER_RESPONSE_STATUSES = [
  'queued',
  'running',
  'verifying',
  'succeeded',
  'failed',
] as const;
export type OfferResponseStatus = (typeof OFFER_RESPONSE_STATUSES)[number];

/** `offer_check.last_outcome`. */
export const OFFER_CHECK_OUTCOMES = ['succeeded', 'failed'] as const;
export type OfferCheckOutcome = (typeof OFFER_CHECK_OUTCOMES)[number];

/**
 * The background reads of a connection whose health is kept for the owner
 * (`background_read_health.read`, docs/features/read-health.md).
 */
export const BACKGROUND_READS = ['sale_check', 'listing_import', 'offer_check'] as const;
export type BackgroundRead = (typeof BACKGROUND_READS)[number];

/** `item_scan.call` (docs/features/thrift-scan.md); `SCAN_CALLS` in @listora/sourcing. */
export const ITEM_SCAN_CALLS = ['buy', 'your_call', 'skip'] as const;
export type ItemScanCall = (typeof ITEM_SCAN_CALLS)[number];

/** `item_scan.confidence`: how sure the call is. */
export const ITEM_SCAN_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type ItemScanConfidence = (typeof ITEM_SCAN_CONFIDENCES)[number];

/** `item_scan.basis`: where the range the call rests on came from. */
export const ITEM_SCAN_BASES = ['own_history', 'web_info', 'ai_estimate', 'none'] as const;
export type ItemScanBasis = (typeof ITEM_SCAN_BASES)[number];

/**
 * `item_scan.decision`: `undecided` until the seller keeps the scan, a later scan of the same
 * item replaces it, or its run ends with it not kept (`skipped`).
 */
export const ITEM_SCAN_DECISIONS = ['undecided', 'kept', 'skipped', 'replaced'] as const;
export type ItemScanDecision = (typeof ITEM_SCAN_DECISIONS)[number];

/** `scan_research.kind`: an item's web facts, or a brand's (kept shorter). */
export const SCAN_RESEARCH_KINDS = ['item', 'brand'] as const;
export type ScanResearchKind = (typeof SCAN_RESEARCH_KINDS)[number];

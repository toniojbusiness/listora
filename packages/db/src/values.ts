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

export const PHOTO_ROLES = ['front', 'back', 'tag', 'flaw', 'detail'] as const;
export type PhotoRole = (typeof PHOTO_ROLES)[number];

export const ANALYSIS_TIERS = ['standard', 'premium'] as const;
export type AnalysisTier = (typeof ANALYSIS_TIERS)[number];

export const ANALYSIS_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const AI_PROVIDERS = ['fake', 'anthropic'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const CONNECTION_MODES = ['api', 'assisted'] as const;
export type ConnectionMode = (typeof CONNECTION_MODES)[number];

export const CONNECTION_STATUSES = ['connected', 'degraded', 'reauth_required', 'revoked'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

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
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

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

export const OPERATION_ORIGINS = ['user', 'auto_delist', 'reprice_rule'] as const;
export type OperationOrigin = (typeof OPERATION_ORIGINS)[number];

export const USER_TASK_KINDS = [
  'list_manually',
  'delist_manually',
  'confirm_sale',
  'reconnect',
  'review_match',
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

export const SALE_DETECTION_SOURCES = ['webhook', 'poll', 'email', 'manual'] as const;
export type SaleDetectionSource = (typeof SALE_DETECTION_SOURCES)[number];

export const SALE_STATUSES = ['detected', 'confirmed', 'canceled', 'returned'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

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

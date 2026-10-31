export { brandKey } from './brand.ts';
export {
  CALL_BASES,
  CALL_CONFIDENCES,
  DEFAULT_SCAN_CALL_SETTINGS,
  decideCall,
  SCAN_CALLS,
  SCAN_SIGNAL_KINDS,
  scanCall,
} from './call.ts';
export type {
  CallBasis,
  CallConfidence,
  ScanCall,
  ScanCallInput,
  ScanCallKind,
  ScanCallSettings,
  ScanFlags,
  ScanSignal,
  ScanSignalKind,
} from './call.ts';
export { buildSourcingKit, MAX_KIT_BUCKETS, SOURCING_KIT_VERSION } from './kit.ts';
export type { SourcingKitInput } from './kit.ts';
export { OFFLINE_CALL_LABEL, offlineScanCall, tagBrandBucket } from './offline-call.ts';
export type { OfflineScanRead } from './offline-call.ts';
export { unsoldLikeIt } from './unsold.ts';
export type { UnsoldItem, UnsoldLikeIt } from './unsold.ts';
export {
  MATCH_LEVELS,
  MIN_COMPARISONS,
  MIN_OWN_HISTORY_SALES,
  OWN_HISTORY_WINDOW_DAYS,
  ownHistoryByMarketplace,
  ownHistoryComparisons,
  payoutMarketplaceOf,
  brandResearchKey,
  itemResearchKey,
  scanOwnHistory,
} from './own-history.ts';
export type {
  HistorySale,
  MarketplaceOwnHistory,
  MatchLevel,
  OwnHistoryComparisons,
  OwnHistoryItem,
  OwnSale,
  ResearchItem,
  ScanIdentity,
  ScanOwnHistory,
} from './own-history.ts';
export { MAX_SIZE_BUCKET_LENGTH, sizeBucket } from './size.ts';
export { medianCents, quartiles } from './stats.ts';
export type { PriceQuartiles } from './stats.ts';
export {
  salesTrend,
  TREND_DIRECTIONS,
  TREND_MIN_EARLIER,
  TREND_MIN_RECENT,
  TREND_RATIO,
  TREND_RECENT_DAYS,
  TREND_SOURCES,
  TREND_WINDOW_DAYS,
} from './trend.ts';
export type { SalesTrend, TrendDirection, TrendSource } from './trend.ts';
export {
  RUN_ESTIMATE_AI_LABEL,
  RUN_ESTIMATE_LABEL,
  RUN_PROFIT_LABEL,
  runEstimate,
  runProfit,
} from './run.ts';
export type { KeptScanCall, RunEstimate } from './run.ts';
export {
  DEMAND_CROWDED_SUPPLY,
  DEMAND_LOW_SUPPLY,
  DEMAND_STRONG_OWN_SALES,
  MARKET_DEMANDS,
  MARKET_MATCH_LEVELS,
  MIN_MARKET_MATCHES,
  marketDemand,
  marketStats,
  withoutOutliers,
} from './market.ts';
export type {
  MarketDemand,
  MarketDemandRead,
  MarketListing,
  MarketMatchLevel,
  MarketStats,
  MarketTarget,
} from './market.ts';

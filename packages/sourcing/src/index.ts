export {
  brandKey,
  SNAP_MAX_EDIT_SHARE,
  SNAP_MAX_EDITS,
  SNAP_MIN_KEY_LENGTH,
  snapBrand,
} from './brand.ts';
export type { SnappedBrand } from './brand.ts';
export {
  calibratedAiEstimate,
  calibratedWebAsks,
  calibrationPercent,
  DEFAULT_PRICE_CALIBRATION_SETTINGS,
  priceCalibration,
} from './calibration.ts';
export type { PriceCalibration, PriceCalibrationSettings, PriceRange } from './calibration.ts';
export { friendlyPrice, scanPrices } from './prices.ts';
export type { ScanPrices } from './prices.ts';
export {
  CALL_BASES,
  CALL_CONFIDENCES,
  DEFAULT_SCAN_CALL_SETTINGS,
  decideCall,
  SCAN_CALLS,
  callWhy,
  pricesSignal,
  SCAN_SIGNAL_KINDS,
  scanCall,
  soldPace,
} from './call.ts';
export type {
  ScanCallPrices,
  CallBasis,
  CallConfidence,
  MarketCallInput,
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
export {
  buildSourcingInsights,
  INSIGHT_GOOD_SELL_THROUGH_BP,
  INSIGHT_LIST_LENGTH,
  INSIGHT_MIN_DAYS_SALES,
  INSIGHT_MIN_ITEMS,
  INSIGHT_SLOW_DAYS,
  INSIGHT_UNSOLD_MIN_AGE_DAYS,
} from './insights.ts';
export type { SourcingInsightsInput } from './insights.ts';
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
export {
  LATEST_SOLD_FAST,
  LATEST_SOLD_SLOW,
  latestSoldPace,
  marketRecentSoldPace,
  marketSoldPace,
  MIN_LATEST_SOLD,
  RECENT_PACE_DAYS,
  RECENT_SOLD_FAST,
  RECENT_SOLD_SLOW,
  SELL_THROUGH_FAST,
  SELL_THROUGH_SLOW,
  type RecentSoldInput,
} from './pace.ts';
export type {
  MarketDemand,
  MarketDemandRead,
  MarketListing,
  MarketMatchLevel,
  MarketStats,
  MarketTarget,
} from './market.ts';

/**
 * The scan's answer (`ItemScan`): what the AI read, the household's own sales like the item,
 * the labeled AI estimate, and the call, rebuilt from the stored row so a scan reads the same
 * every time.
 */
import type { ItemScan, ScanCall, ScanOwnSales } from '@listora/api-contract';
import { WEB_INFO_LABEL, type ThriftScan } from '@listora/analysis';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import { AI_ESTIMATE_LABEL, OWN_SALES_MAY_MODEL_PRICES, scanResearchLinks } from '@listora/pricing';
import type { ScanCall as RuleCall, ScanOwnHistory } from '@listora/sourcing';
import { assertNever } from '@listora/shared';

import { ownHistoryLabel } from '../sourcing/own-history.ts';
import { comparisonView } from './comparisons.ts';
import type { ItemScanRow, ScanCallDetail, StoredResearch } from './repository.ts';

const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });

/** The call as the seller reads it. */
export function callLabel(call: RuleCall['call']): string {
  switch (call) {
    case 'buy':
      return 'Buy';
    case 'your_call':
      return 'Your call';
    case 'skip':
      return 'Skip';
    default:
      return assertNever(call);
  }
}

/** The call and the card's own-sales lines, as stored with the scan and shown on its card. */
export function callDetail(input: {
  readonly rule: RuleCall;
  readonly history: ScanOwnHistory;
  /** The identified brand, which the lines' labels name. */
  readonly brand: string | null;
  readonly range: { readonly lowCents: number; readonly highCents: number } | undefined;
  readonly worthListingCents: number;
}): ScanCallDetail {
  const { rule, history, range } = input;
  const call: ScanCall = {
    call: rule.call,
    label: callLabel(rule.call),
    confidence: rule.confidence,
    basis: rule.basis,
    basedOn: rule.basedOn,
    ...(range === undefined ? {} : { low: usd(range.lowCents), high: usd(range.highCents) }),
    ...(rule.conservativePayoutCents === undefined
      ? {}
      : { conservativePayout: usd(rule.conservativePayoutCents) }),
    ...(rule.optimisticPayoutCents === undefined
      ? {}
      : { optimisticPayout: usd(rule.optimisticPayoutCents) }),
    ...(range === undefined ? {} : { payoutMarketplace: history.payoutMarketplace }),
    worthListing: usd(input.worthListingCents),
    signals: rule.signals.map((signal) => ({ ...signal })),
  };
  const ownSales: ScanOwnSales[] = history.byMarketplace.map(({ marketplace, level, prices }) => ({
    marketplace,
    label: ownHistoryLabel(input.brand ?? '', MARKETPLACE_NAMES[marketplace], level),
    soldCount: prices.count,
    low: usd(prices.lowCents),
    median: usd(prices.medianCents),
    high: usd(prices.highCents),
    displayOnly: !OWN_SALES_MAY_MODEL_PRICES[marketplace],
  }));
  return { call, ownSales };
}

export function scanView(row: ItemScanRow): ItemScan {
  const read = row.read as unknown as ThriftScan;
  const detail = row.call_detail as unknown as ScanCallDetail;
  const identity: ItemScan['identity'] = {
    item: read.item,
    ...(read.brand === null ? {} : { brand: read.brand }),
    ...(read.category === null ? {} : { category: read.category }),
    ...(read.department === null ? {} : { department: read.department }),
    ...(read.sizeLabel === null ? {} : { sizeLabel: read.sizeLabel }),
    ...(read.condition === null ? {} : { condition: read.condition }),
    ...(read.line === null ? {} : { model: read.line }),
    ...(read.styleNumber === null ? {} : { styleNumber: read.styleNumber }),
    ...(read.era === null ? {} : { era: read.era }),
    ...(read.style === null ? {} : { style: read.style }),
    confidence: read.identityConfidence,
  };
  const research =
    row.research === null ? undefined : researchView(row.research as unknown as StoredResearch);
  return {
    id: row.id,
    runId: row.run_id,
    createdAt: row.created_at.toISOString(),
    identity,
    ...(read.aiEstimate === null
      ? {}
      : {
          aiEstimate: {
            label: AI_ESTIMATE_LABEL,
            low: usd(read.aiEstimate.lowCents),
            mid: usd(read.aiEstimate.midCents),
            high: usd(read.aiEstimate.highCents),
          },
        }),
    flags: read.flags,
    ...(detail.retail === undefined ? {} : { retail: detail.retail }),
    ...(detail.trend === undefined ? {} : { trend: detail.trend }),
    ...(research === undefined ? {} : { research }),
    ownSales: [...detail.ownSales],
    ...(detail.comparisons === undefined || detail.comparisons.length === 0
      ? {}
      : {
          comparisons: detail.comparisons.map((comparison) =>
            comparisonView(comparison, detail.recentOwnSales ?? 0),
          ),
        }),
    call: detail.call,
    searchWords: read.searchWords,
    researchLinks: scanResearchLinks(read.searchWords === '' ? read.item : read.searchWords),
    decision: row.decision,
    ...(row.item_id === null ? {} : { itemId: row.item_id }),
  };
}

function researchView(stored: StoredResearch): NonNullable<ItemScan['research']> {
  const found = stored.research;
  return {
    status: stored.status,
    label: WEB_INFO_LABEL,
    ...(found?.retail
      ? {
          retail: {
            low: usd(found.retail.lowCents),
            high: usd(found.retail.highCents),
            sources: found.retail.sources.map((source) => ({ ...source })),
            models: [...found.retail.models],
          },
        }
      : {}),
    ...(found?.resale
      ? {
          resale: {
            low: usd(found.resale.lowCents),
            high: usd(found.resale.highCents),
            sources: found.resale.sources.map((source) => ({ ...source })),
          },
        }
      : {}),
    reputation: found?.reputation ?? 'unknown',
    ...(found?.summary ? { summary: found.summary } : {}),
    cached: stored.cached,
  };
}

import type {
  DelistResult,
  DelistRun,
  DoubleSale,
  Sale,
  UserTaskStatus,
} from '@listora/api-contract';
import type { DelistRunView, DelistResult as RunResult } from '@listora/auto-delist';
import type { Marketplace } from '@listora/db';
import { isMarketplace, orderCancelGuide, orderCancelTitle } from '@listora/marketplaces';

import {
  CONTRACT_DELIST_RUN_STATUS,
  type DoubleSaleTaskRow,
  type SaleItemRow,
  type SaleRow,
} from './repository.ts';

/**
 * The contract's `DelistRun`: the per-marketplace truth computed from the run's operations
 * (`loadDelistRuns`), never a stored summary.
 */
export function delistRunView(run: DelistRunView): DelistRun {
  return {
    id: run.id,
    saleId: run.saleId,
    itemId: run.itemId,
    soldOn: run.soldOn,
    status: CONTRACT_DELIST_RUN_STATUS[run.status],
    statusDisplay: run.display,
    results: run.results.map(delistResultView),
    escalated: run.escalated,
    startedAt: run.startedAt.toISOString(),
    ...(run.realertedAt === null ? {} : { realertedAt: run.realertedAt.toISOString() }),
    ...(run.escalatedAt === null ? {} : { escalatedAt: run.escalatedAt.toISOString() }),
    ...(run.completedAt === null ? {} : { completedAt: run.completedAt.toISOString() }),
  };
}

function delistResultView(result: RunResult): DelistResult {
  return {
    listingId: result.listingId,
    marketplace: result.marketplace,
    mode: result.mode,
    state: result.state,
    statusDisplay: result.display,
    operationId: result.operationId,
    attempt: result.operation.attempts,
    maxAttempts: result.maxAttempts,
    ...(result.userTaskId === null ? {} : { userTaskId: result.userTaskId }),
    updatedAt: result.updatedAt.toISOString(),
  };
}

const TASK_STATUS = {
  open: 'open',
  done: 'completed',
  dismissed: 'dismissed',
} as const satisfies Record<DoubleSaleTaskRow['status'], UserTaskStatus>;

/**
 * The contract's `DoubleSale` from its task. The steps come from the task as it was opened; a
 * task whose payload lacks them (it never should) shows the marketplace's current steps.
 */
export function doubleSaleView(task: DoubleSaleTaskRow): DoubleSale {
  if (task.sale_id === null || task.item_id === null) {
    throw new Error(`double-sale task ${task.id} has no sale or item`);
  }
  const payload = task.payload as Record<string, unknown>;
  const marketplace = marketplaceIn(payload['marketplace']);
  const earlierMarketplace = marketplaceIn(payload['earlierMarketplace']);
  const earlierSaleId = payload['earlierSaleId'];
  if (marketplace === null || earlierMarketplace === null || typeof earlierSaleId !== 'string') {
    throw new Error(`double-sale task ${task.id} has an unreadable payload`);
  }
  const guide = orderCancelGuide(marketplace);
  const steps = payload['steps'];
  const title = payload['title'];
  return {
    taskId: task.id,
    saleId: task.sale_id,
    itemId: task.item_id,
    marketplace,
    earlierSaleId,
    earlierMarketplace,
    title: typeof title === 'string' ? title : orderCancelTitle(marketplace),
    steps:
      Array.isArray(steps) && steps.every((step) => typeof step === 'string')
        ? steps
        : [...guide.steps],
    cancelUrl: task.deep_link ?? guide.url,
    status: TASK_STATUS[task.status],
    createdAt: task.created_at.toISOString(),
    ...(task.completed_at === null ? {} : { resolvedAt: task.completed_at.toISOString() }),
  };
}

function marketplaceIn(value: unknown): Marketplace | null {
  return typeof value === 'string' && isMarketplace(value) ? value : null;
}

/** The contract's `Sale`. Fees, shipping cost, and profit are absent until they are known (T-26). */
export function saleView(
  sale: SaleRow,
  items: readonly SaleItemRow[],
  runs: readonly DelistRunView[],
  doubleSales: readonly DoubleSaleTaskRow[],
): Sale {
  const salePriceCents = items.reduce((sum, item) => sum + item.sale_price_cents, 0);
  return {
    id: sale.id,
    marketplace: sale.marketplace,
    ...(sale.external_order_id === null ? {} : { externalOrderId: sale.external_order_id }),
    items: items.map((item) => ({
      itemId: item.item_id,
      ...(item.listing_id === null ? {} : { listingId: item.listing_id }),
      salePrice: { amountCents: item.sale_price_cents, currency: item.currency },
    })),
    soldAt: sale.sold_at.toISOString(),
    salePrice: { amountCents: salePriceCents, currency: sale.currency },
    shippingCharged: { amountCents: sale.shipping_charged_cents, currency: sale.currency },
    detectionSource: sale.detection_source,
    status: sale.status,
    ...(sale.ship_by === null ? {} : { shipBy: sale.ship_by.toISOString() }),
    isDoubleSale: doubleSales.length > 0,
    delistRuns: runs.map(delistRunView),
    doubleSales: doubleSales.map(doubleSaleView),
    createdAt: sale.created_at.toISOString(),
    updatedAt: sale.updated_at.toISOString(),
  };
}

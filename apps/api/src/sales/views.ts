import type {
  DelistResult,
  DelistRun,
  DoubleSale,
  RelistOption,
  Sale,
  UserTaskStatus,
} from '@listora/api-contract';
import type { DelistRunView, DelistResult as RunResult } from '@listora/auto-delist';
import type { Marketplace } from '@listora/db';
import { isMarketplace, orderCancelGuide, orderCancelTitle } from '@listora/marketplaces';
import { availableSaleActions, saleMoney, type SaleMoney } from '@listora/sales';

import {
  CONTRACT_DELIST_RUN_STATUS,
  type DoubleSaleTaskRow,
  type FeeLineRow,
  type SaleItemDetailRow,
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

/** One item's relist question after a canceled or returned sale: its listings now. */
export type RelistOptions = Map<string, RelistOption[]>;

/** The sale's money, from its rows (`saleMoney` in `@listora/sales`). */
export function moneyOfSale(
  sale: SaleRow,
  items: readonly SaleItemDetailRow[],
  fees: readonly FeeLineRow[],
): SaleMoney {
  return saleMoney({
    shippingChargedCents: sale.shipping_charged_cents,
    shippingCostCents: sale.shipping_cost_cents,
    items: items.map((item) => ({
      saleItemId: item.id,
      itemId: item.item_id,
      salePriceCents: item.sale_price_cents,
      costCents: item.cost_cents,
    })),
    fees: fees.map((fee) => ({
      saleItemId: fee.sale_item_id,
      amountCents: fee.amount_cents,
      source: fee.source,
    })),
  });
}

/**
 * The contract's `Sale`: the order, its items with each one's share of the money, its fee
 * lines, the payout and profit (estimates while `feesEstimated`), the actions its status
 * allows, its delist runs and double sales, and, once canceled or returned, the relist question
 * for each item.
 */
export function saleView(
  sale: SaleRow,
  items: readonly SaleItemDetailRow[],
  fees: readonly FeeLineRow[],
  runs: readonly DelistRunView[],
  doubleSales: readonly DoubleSaleTaskRow[],
  relistOptions: RelistOptions,
  /** Each item's cover photo, small, once processed. */
  thumbnails: ReadonlyMap<string, string> = new Map(),
): Sale {
  const money = moneyOfSale(sale, items, fees);
  const usd = (amountCents: number) => ({ amountCents, currency: sale.currency });
  const optional = <K extends string>(key: K, cents: number | null) =>
    (cents === null ? {} : { [key]: usd(cents) }) as Partial<Record<K, ReturnType<typeof usd>>>;
  return {
    id: sale.id,
    marketplace: sale.marketplace,
    ...(sale.external_order_id === null ? {} : { externalOrderId: sale.external_order_id }),
    items: items.map((item) => {
      const share = money.items.get(item.item_id);
      return {
        itemId: item.item_id,
        sku: item.sku,
        ...(item.title === null || item.title === '' ? {} : { title: item.title }),
        ...thumbnailOf(thumbnails, item.item_id),
        ...(item.listing_id === null ? {} : { listingId: item.listing_id }),
        salePrice: { amountCents: item.sale_price_cents, currency: item.currency },
        ...optional('cost', item.cost_cents),
        ...(fees.length === 0 || share === undefined ? {} : { fees: usd(share.feesCents) }),
        ...optional('netProceeds', share?.netProceedsCents ?? null),
        ...optional('profit', share?.profitCents ?? null),
        ...(share === undefined || share.roiBasisPoints === null
          ? {}
          : { roiBasisPoints: share.roiBasisPoints }),
        ...(item.relist_decision === null
          ? {}
          : {
              relist: {
                decision: item.relist_decision,
                options: relistOptions.get(item.item_id) ?? [],
                ...(item.relist_decided_at === null
                  ? {}
                  : { decidedAt: item.relist_decided_at.toISOString() }),
              },
            }),
      };
    }),
    soldAt: sale.sold_at.toISOString(),
    salePrice: usd(money.salePriceCents),
    shippingCharged: usd(sale.shipping_charged_cents),
    ...(fees.length === 0
      ? {}
      : {
          fees: fees.map((fee) => ({
            type: fee.kind,
            amount: { amountCents: fee.amount_cents, currency: fee.currency },
            source: fee.source,
            ...(fee.description === null ? {} : { description: fee.description }),
            ...(fee.fee_table_version === null ? {} : { feeTableVersion: fee.fee_table_version }),
          })),
          feesEstimated: money.feesEstimated,
        }),
    ...optional('shippingCost', sale.shipping_cost_cents),
    ...optional('netProceeds', money.netProceedsCents),
    ...optional('profit', money.profitCents),
    ...optional('cost', money.costCents),
    ...(money.roiBasisPoints === null ? {} : { roiBasisPoints: money.roiBasisPoints }),
    detectionSource: sale.detection_source,
    status: sale.status,
    ...(sale.ship_by === null ? {} : { shipBy: sale.ship_by.toISOString() }),
    availableActions: availableSaleActions(sale.status),
    ...timestamp('confirmedAt', sale.confirmed_at),
    ...timestamp('shippedAt', sale.shipped_at),
    ...timestamp('canceledAt', sale.canceled_at),
    ...timestamp('returnedAt', sale.returned_at),
    isDoubleSale: doubleSales.length > 0,
    delistRuns: runs.map(delistRunView),
    doubleSales: doubleSales.map(doubleSaleView),
    createdAt: sale.created_at.toISOString(),
    updatedAt: sale.updated_at.toISOString(),
  };
}

function thumbnailOf(
  thumbnails: ReadonlyMap<string, string>,
  itemId: string,
): { thumbnailUrl?: string } {
  const thumbnail = thumbnails.get(itemId);
  return thumbnail === undefined ? {} : { thumbnailUrl: thumbnail };
}

function timestamp<K extends string>(key: K, at: Date | null): Partial<Record<K, string>> {
  return (at === null ? {} : { [key]: at.toISOString() }) as Partial<Record<K, string>>;
}

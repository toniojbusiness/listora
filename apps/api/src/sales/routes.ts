import type { MarketplaceSales, RelistOption, SaleCreate } from '@listora/api-contract';
import { loadDelistRuns } from '@listora/auto-delist';
import { inTransaction, MARKETPLACES, type DbExecutor, type DbTransaction } from '@listora/db';
import {
  changeSale,
  finishInboundEvent,
  recordInboundEvent,
  recordRelistDecision,
  recordSale,
  SaleNotFoundError,
  SaleStateError,
  type SaleAction,
} from '@listora/sales';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { contractRoute } from '../contract/routes.ts';
import { ApiError, notFound, validationFailed } from '../errors.ts';
import type { ApiRouteContext } from '../features.ts';
import { coverPhotoRows } from '../items/repository.ts';
import { relistListing } from '../listings/actions.ts';
import { itemListingRows } from '../listings/repository.ts';
import { listingStates, listingView, type ListingViewContext } from '../listings/views.ts';
import { DEFAULT_PAGE_SIZE } from '../pagination.ts';
import { photoFromRow, type PublicUrls } from '../photos/mapping.ts';
import { decodeSortCursor, encodeSortCursor } from '../sorting.ts';
import type { Tenant } from '../tenancy.ts';
import {
  connectedMarketplaces,
  doubleSaleRows,
  feeLineRows,
  findSale,
  listSaleRows,
  marketplaceSalesRows,
  saleItemRows,
  type SaleItemDetailRow,
  type SaleRow,
} from './repository.ts';
import { DEFAULT_SALE_SORT, saleSortTerms } from './sort.ts';
import { saleView, type RelistOptions } from './views.ts';

/** How far ahead of the server's clock a hand-entered sale time may be (a phone's clock drifts). */
const SOLD_AT_FUTURE_TOLERANCE_MS = 5 * 60_000;

/** What a sale's view needs besides its rows: the listings' adapters and the photos' URLs. */
type SaleViewContext = ListingViewContext & { urls: PublicUrls };

/**
 * The sales feed (`listSales`, `getSale`), the seller's sales in total and per marketplace
 * (`getSalesSummary`), recording a sale by hand (`createSale`, "Mark sold"),
 * the sale lifecycle (`confirmSale`, `markSaleShipped`, `cancelSale`, `recordSaleReturn`), and
 * the answer to "Relist it?" after a cancel or return (`decideSaleRelist`); see
 * docs/features/sales.md.
 */
export function registerSaleRoutes(app: FastifyInstance, deps: ApiRouteContext): void {
  const views: SaleViewContext = { adapters: deps.connections.adapters, urls: deps.storage };

  contractRoute(app, deps, 'listSales', async ({ tenant, db, query }) => {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const sort = query.sort ?? DEFAULT_SALE_SORT;
    const rows = await listSaleRows(db, tenant, {
      itemId: query.itemId,
      statuses: query.status,
      delistStatuses: query.delistStatus,
      sort,
      after:
        query.cursor === undefined
          ? undefined
          : decodeSortCursor(query.cursor, sort, saleSortTerms(sort)),
      limit,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      status: 200,
      body: {
        data: await saleViews(db, tenant, page, views),
        ...(rows.length > limit && last
          ? { nextCursor: encodeSortCursor(sort, last.sort_key) }
          : {}),
      },
    };
  });

  contractRoute(app, deps, 'getSalesSummary', async ({ tenant, db }) => {
    const [rows, connected] = await Promise.all([
      marketplaceSalesRows(db, tenant),
      connectedMarketplaces(db, tenant),
    ]);
    const byMarketplace = new Map(rows.map((row) => [row.marketplace, row]));
    // The fixed order, never ranked (docs/features/profit.md): eBay's licence forbids comparing.
    const marketplaces = MARKETPLACES.flatMap((marketplace): MarketplaceSales[] => {
      const row = byMarketplace.get(marketplace);
      if (row === undefined && !connected.includes(marketplace)) return [];
      return [
        {
          marketplace,
          salesCount: row?.salesCount ?? 0,
          itemsSold: row?.itemsSold ?? 0,
          revenue: { amountCents: row?.revenueCents ?? 0, currency: 'USD' },
        },
      ];
    });
    const first = rows.reduce<Date | null>(
      (earliest, row) =>
        earliest === null || row.firstSoldAt < earliest ? row.firstSoldAt : earliest,
      null,
    );
    const sum = (pick: (row: MarketplaceSales) => number) =>
      marketplaces.reduce((total, row) => total + pick(row), 0);
    return {
      status: 200,
      body: {
        total: {
          salesCount: sum((row) => row.salesCount),
          itemsSold: sum((row) => row.itemsSold),
          revenue: { amountCents: sum((row) => row.revenue.amountCents), currency: 'USD' as const },
        },
        marketplaces,
        ...(first === null ? {} : { firstSoldAt: first.toISOString() }),
      },
    };
  });

  contractRoute(app, deps, 'getSale', async ({ tenant, db, params }) => ({
    status: 200,
    body: await oneSaleView(db, tenant, params.saleId, views),
  }));

  contractRoute(app, deps, 'createSale', async ({ tenant, db, body, request }) =>
    inTransaction(db, async (trx) => {
      const lines = await checkedLines(trx, tenant, body);
      const soldAt = body.soldAt === undefined ? new Date() : new Date(body.soldAt);
      if (soldAt.getTime() > Date.now() + SOLD_AT_FUTURE_TOLERANCE_MS) {
        throw validationFailed(
          [{ field: 'soldAt', message: 'must not be in the future' }],
          'The sold date is in the future.',
        );
      }
      // The same intake as a detected sale: an inbound event, then `recordSale`, which starts
      // the delists on every other marketplace in this transaction.
      const event = await recordInboundEvent(trx, {
        accountId: tenant.accountId,
        source: 'manual',
        marketplace: body.marketplace,
        providerEventId: `manual:${requestKey(request)}`,
        signatureOk: null,
        payload: {
          marketplace: body.marketplace,
          items: lines.map((line) => ({ itemId: line.itemId, priceCents: line.priceCents })),
        },
        externalUserId: null,
      });
      const result = await recordSale(
        trx,
        {
          accountId: tenant.accountId,
          marketplace: body.marketplace,
          externalOrderId: orderId(body.externalOrderId),
          soldAt,
          currency: 'USD',
          shippingChargedCents: body.shippingCharged?.amountCents ?? 0,
          detectionSource: 'manual',
          inboundEventId: event.id,
          shipBy: null,
          lines,
        },
        { adapters: deps.connections.adapters.lookup },
      );
      if (result.type === 'duplicate') {
        throw new ApiError('already_exists', 'This order is already recorded in Listora.');
      }
      if (result.type === 'not_listora') throw notFound('Item');
      await finishInboundEvent(trx, tenant.accountId, event.id, 'processed');
      return { status: 201 as const, body: await oneSaleView(trx, tenant, result.saleId, views) };
    }),
  );

  const lifecycle = async (
    db: DbExecutor,
    tenant: Tenant,
    saleId: string,
    action: SaleAction,
    shippingCostCents?: number,
  ) => {
    await saleCommand(() =>
      changeSale(db, {
        accountId: tenant.accountId,
        saleId,
        action,
        userId: tenant.userId,
        ...(shippingCostCents === undefined ? {} : { shippingCostCents }),
      }),
    );
    return { status: 200 as const, body: await oneSaleView(db, tenant, saleId, views) };
  };
  contractRoute(app, deps, 'confirmSale', ({ tenant, db, params }) =>
    lifecycle(db, tenant, params.saleId, 'confirm'),
  );
  contractRoute(app, deps, 'markSaleShipped', ({ tenant, db, params, body }) => {
    const cost = body.shippingCost;
    if (cost !== undefined && cost.amountCents < 0) {
      throw validationFailed(
        [{ field: 'shippingCost', message: 'must not be negative' }],
        'Enter a label cost of $0 or more.',
      );
    }
    return lifecycle(db, tenant, params.saleId, 'mark_shipped', cost?.amountCents);
  });
  contractRoute(app, deps, 'cancelSale', ({ tenant, db, params }) =>
    lifecycle(db, tenant, params.saleId, 'cancel'),
  );
  contractRoute(app, deps, 'recordSaleReturn', ({ tenant, db, params }) =>
    lifecycle(db, tenant, params.saleId, 'record_return'),
  );

  contractRoute(app, deps, 'decideSaleRelist', async ({ tenant, db, params, body, request }) => {
    // An idempotent POST runs in the request's transaction, so a failed relist undoes the
    // decisions and every relist queued before it.
    if (!db.isTransaction)
      throw new Error("decideSaleRelist must run in the request's transaction");
    const trx = db as DbTransaction;
    const sale = await findSale(trx, tenant, params.saleId);
    if (!sale) throw notFound('Sale');
    const items = (await saleItemRows(trx, tenant, [sale.id])).get(sale.id) ?? [];
    const options = await relistOptions(trx, tenant, items, views);
    const seen = new Set<string>();
    for (const [index, choice] of body.items.entries()) {
      const field = `items[${String(index)}]`;
      if (seen.has(choice.itemId)) {
        throw validationFailed(
          [{ field, message: 'lists an item twice' }],
          'Each item appears once.',
        );
      }
      seen.add(choice.itemId);
      if (!items.some((item) => item.item_id === choice.itemId)) {
        throw validationFailed(
          [{ field, message: 'is not an item of this sale' }],
          'That item is not in this sale.',
        );
      }
      const relistable = new Set(
        (options.get(choice.itemId) ?? [])
          .filter((option) => option.canRelist)
          .map((option) => option.listingId),
      );
      const listingIds = [...new Set(choice.listingIds)];
      const refused = listingIds.find((id) => !relistable.has(id));
      if (refused !== undefined) {
        throw validationFailed(
          [
            {
              field: `${field}.listingIds`,
              message: 'can only name listings Listora can relist now',
            },
          ],
          "Listora can't relist that listing now.",
        );
      }
      await saleCommand(() =>
        recordRelistDecision(trx, {
          accountId: tenant.accountId,
          saleId: sale.id,
          itemId: choice.itemId,
          decision: listingIds.length === 0 ? 'declined' : 'relisted',
          userId: tenant.userId,
          listingIds,
        }),
      );
      for (const listingId of listingIds) {
        await relistListing(trx, tenant, listingId, `${requestKey(request)}:${listingId}`, deps);
      }
    }
    return { status: 200, body: await oneSaleView(trx, tenant, sale.id, views) };
  });
}

/** The order's lines from a "Mark sold" body, refused (`422`) where they can't be recorded. */
async function checkedLines(db: DbExecutor, tenant: Tenant, body: SaleCreate) {
  const seen = new Set<string>();
  const lines = [];
  for (const [index, line] of body.items.entries()) {
    const field = `items[${String(index)}]`;
    if (seen.has(line.itemId)) {
      throw validationFailed(
        [{ field, message: 'lists an item twice' }],
        'Each item appears once.',
      );
    }
    seen.add(line.itemId);
    if (line.salePrice.amountCents < 0) {
      throw validationFailed(
        [{ field: `${field}.salePrice`, message: 'must not be negative' }],
        'Enter a sale price of $0 or more.',
      );
    }
    const item = await db
      .selectFrom('inventory_item')
      .select('id')
      .where('account_id', '=', tenant.accountId)
      .where('id', '=', line.itemId)
      .executeTakeFirst();
    if (item === undefined) throw notFound('Item');
    if (line.listingId !== undefined) {
      const listing = await db
        .selectFrom('marketplace_listing')
        .select('id')
        .where('account_id', '=', tenant.accountId)
        .where('id', '=', line.listingId)
        .where('item_id', '=', line.itemId)
        .where('marketplace', '=', body.marketplace)
        .executeTakeFirst();
      if (listing === undefined) {
        throw validationFailed(
          [
            {
              field: `${field}.listingId`,
              message: "is not this item's listing on the marketplace",
            },
          ],
          "That listing isn't this item's listing on the marketplace it sold on.",
        );
      }
    }
    lines.push({
      itemId: line.itemId,
      listingId: line.listingId ?? null,
      quantity: 1,
      priceCents: line.salePrice.amountCents,
    });
  }
  if ((body.shippingCharged?.amountCents ?? 0) < 0) {
    throw validationFailed(
      [{ field: 'shippingCharged', message: 'must not be negative' }],
      'Enter a shipping charge of $0 or more.',
    );
  }
  return lines;
}

/** Runs a lifecycle command, answering its refusals as the contract's errors. */
async function saleCommand<T>(command: () => Promise<T>): Promise<T> {
  try {
    return await command();
  } catch (error) {
    if (error instanceof SaleNotFoundError) throw notFound('Sale');
    if (error instanceof SaleStateError) {
      throw new ApiError('invalid_state_transition', error.userMessage, { cause: error });
    }
    throw error;
  }
}

async function oneSaleView(db: DbExecutor, tenant: Tenant, saleId: string, views: SaleViewContext) {
  const sale = await findSale(db, tenant, saleId);
  if (!sale) throw notFound('Sale');
  const [view] = await saleViews(db, tenant, [sale], views);
  if (view === undefined) throw new Error('a sale has no view');
  return view;
}

export async function saleViews(
  db: DbExecutor,
  tenant: Tenant,
  sales: readonly SaleRow[],
  views: SaleViewContext,
) {
  const saleIds = sales.map((sale) => sale.id);
  const [items, fees, runs, doubleSales] = await Promise.all([
    saleItemRows(db, tenant, saleIds),
    feeLineRows(db, tenant, saleIds),
    loadDelistRuns(db, tenant.accountId, { saleIds }),
    doubleSaleRows(db, tenant, { saleIds }),
  ]);
  const allItems = [...items.values()].flat();
  const [options, covers] = await Promise.all([
    relistOptions(db, tenant, allItems, views),
    coverPhotoRows(db, tenant, [...new Set(allItems.map((item) => item.item_id))]),
  ]);
  const thumbnails = new Map(
    [...covers].flatMap(([itemId, cover]) => {
      const thumbnail = photoFromRow(cover, views.urls).urls?.thumbnail;
      return thumbnail === undefined ? [] : [[itemId, thumbnail] as const];
    }),
  );
  return sales.map((sale) =>
    saleView(
      sale,
      items.get(sale.id) ?? [],
      fees.get(sale.id) ?? [],
      runs.filter((run) => run.saleId === sale.id),
      doubleSales.filter((task) => task.sale_id === sale.id),
      options,
      thumbnails,
    ),
  );
}

/**
 * For each item with a relist question: its newest listing on each marketplace, with the
 * listing's honest status and whether Listora can relist it now (only while the question is
 * pending, and only where the item screen would offer Relist).
 */
async function relistOptions(
  db: DbExecutor,
  tenant: Tenant,
  items: readonly SaleItemDetailRow[],
  views: ListingViewContext,
): Promise<RelistOptions> {
  const asked = items.filter((item) => item.relist_decision !== null);
  const options: RelistOptions = new Map();
  if (asked.length === 0) return options;
  const rows = await itemListingRows(db, tenant, [...new Set(asked.map((item) => item.item_id))]);
  for (const item of asked) {
    const states = await listingStates(db, tenant, rows.get(item.item_id) ?? []);
    options.set(
      item.item_id,
      states.map((state): RelistOption => {
        const listing = listingView(state, views);
        const relist = listing.availableActions.find((available) => available.action === 'relist');
        return {
          listingId: listing.id,
          marketplace: listing.marketplace,
          mode: relist?.mode ?? listing.mode,
          statusDisplay: listing.statusDisplay,
          canRelist: item.relist_decision === 'pending' && relist !== undefined,
        };
      }),
    );
  }
  return options;
}

/** A typed order number, or null when the seller left it blank. */
function orderId(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function requestKey(request: FastifyRequest): string {
  return String(request.headers['idempotency-key']);
}

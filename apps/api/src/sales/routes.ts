import { loadDelistRuns } from '@listora/auto-delist';
import type { DbExecutor } from '@listora/db';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { notFound } from '../errors.ts';
import { decodeCursor, DEFAULT_PAGE_SIZE, encodeCursor } from '../pagination.ts';
import type { Tenant } from '../tenancy.ts';
import {
  doubleSaleRows,
  findSale,
  listSaleRows,
  saleItemRows,
  type SaleRow,
} from './repository.ts';
import { saleView } from './views.ts';

/**
 * The sales feed (`listSales`) and one sale (`getSale`), each sale with its delist runs and
 * double-sale incidents (docs/features/auto-delist.md). Recording a sale by hand
 * (`createSale`, "Mark sold") is the sale lifecycle's (T-26).
 */
export function registerSaleRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  contractRoute(app, deps, 'listSales', async ({ tenant, db, query }) => {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const rows = await listSaleRows(db, tenant, {
      itemId: query.itemId,
      statuses: query.status,
      delistStatuses: query.delistStatus,
      beforeId: query.cursor === undefined ? undefined : decodeCursor(query.cursor),
      limit,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      status: 200,
      body: {
        data: await saleViews(db, tenant, page),
        ...(rows.length > limit && last ? { nextCursor: encodeCursor(last.id) } : {}),
      },
    };
  });

  contractRoute(app, deps, 'getSale', async ({ tenant, db, params }) => {
    const sale = await findSale(db, tenant, params.saleId);
    if (!sale) throw notFound('Sale');
    const [view] = await saleViews(db, tenant, [sale]);
    if (view === undefined) throw new Error('a sale has no view');
    return { status: 200, body: view };
  });
}

async function saleViews(db: DbExecutor, tenant: Tenant, sales: readonly SaleRow[]) {
  const saleIds = sales.map((sale) => sale.id);
  const [items, runs, doubleSales] = await Promise.all([
    saleItemRows(db, tenant, saleIds),
    loadDelistRuns(db, tenant.accountId, { saleIds }),
    doubleSaleRows(db, tenant, { saleIds }),
  ]);
  return sales.map((sale) =>
    saleView(
      sale,
      items.get(sale.id) ?? [],
      runs.filter((run) => run.saleId === sale.id),
      doubleSales.filter((task) => task.sale_id === sale.id),
    ),
  );
}

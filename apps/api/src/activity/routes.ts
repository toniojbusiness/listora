import { loadActivity, loadSaleExplanation, type ActivityFilter } from '@listora/activity';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { notFound } from '../errors.ts';
import { findItem } from '../items/repository.ts';
import { findOperation } from '../operations/repository.ts';
import { DEFAULT_PAGE_SIZE } from '../pagination.ts';

import {
  activityEntryView,
  type ActivityUrls,
  decodeActivityCursor,
  encodeActivityCursor,
  saleExplanationView,
} from './views.ts';

/**
 * The activity timeline (docs/features/activity.md): `listItemActivity` and
 * `listOperationActivity`, newest first, read from the records the server, the browser runner,
 * and the phone keep; and `getSaleExplanation`, how a sale was found and what it started.
 */
export interface ActivityRouteDependencies extends RouteDependencies {
  /** Package photos' URLs. */
  storage: ActivityUrls;
}

export function registerActivityRoutes(
  app: FastifyInstance,
  deps: ActivityRouteDependencies,
): void {
  const page = async (
    db: Parameters<typeof loadActivity>[0],
    filter: Omit<ActivityFilter, 'limit' | 'to'>,
    query: { cursor?: string; limit?: number },
  ) => {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const entries = await loadActivity(db, {
      ...filter,
      ...(query.cursor === undefined ? {} : { to: decodeActivityCursor(query.cursor) }),
      limit: limit + 1,
    });
    const shown = entries.slice(0, limit);
    const last = shown.at(-1);
    return {
      status: 200 as const,
      body: {
        data: shown.map((entry) => activityEntryView(entry, deps.storage)),
        ...(entries.length > limit && last ? { nextCursor: encodeActivityCursor(last.at) } : {}),
      },
    };
  };

  contractRoute(app, deps, 'listItemActivity', async ({ tenant, db, params, query }) => {
    const item = await findItem(db, tenant, params.itemId);
    if (!item) throw notFound('Item');
    return page(db, { accountId: tenant.accountId, itemId: item.id }, query);
  });

  contractRoute(app, deps, 'listOperationActivity', async ({ tenant, db, params, query }) => {
    const operation = await findOperation(db, tenant, params.operationId);
    if (!operation) throw notFound('Operation');
    return page(db, { accountId: tenant.accountId, operationId: operation.id }, query);
  });

  contractRoute(app, deps, 'getSaleExplanation', async ({ tenant, db, params }) => {
    const explanation = await loadSaleExplanation(db, {
      accountId: tenant.accountId,
      saleId: params.saleId,
    });
    if (explanation === undefined) throw notFound('Sale');
    return { status: 200, body: saleExplanationView(explanation, deps.storage) };
  });
}

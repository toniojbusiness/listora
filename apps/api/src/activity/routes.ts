import {
  loadActivity,
  loadSaleExplanation,
  type ActivityEntry,
  type ActivityFilter,
} from '@listora/activity';
import { packPhotoUrls } from '@listora/pack-check';
import type { ObjectStorage } from '@listora/storage';
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
 * The seller's activity timeline (docs/features/activity.md): `listItemActivity` and
 * `listOperationActivity`, newest first, and `getSaleExplanation`, how a sale was found and what
 * it started. Only what the seller did or can act on: Listora's own diagnostics (browser
 * sessions, sale checks, step timings) are the operator's (`admin activity`).
 */
export interface ActivityRouteDependencies extends RouteDependencies {
  /** Where package photos are kept: their reads are signed (`packPhotoUrls`). */
  storage: ObjectStorage;
}

/** The signed read URLs of the entries' package photos. */
async function activityUrls(
  storage: ObjectStorage,
  entries: readonly ActivityEntry[],
): Promise<ActivityUrls> {
  const keys = entries.flatMap((entry) => (entry.photoKey === null ? [] : [entry.photoKey]));
  return { photoUrls: await packPhotoUrls(storage, keys, new Date()) };
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
      forSeller: true,
      ...(query.cursor === undefined ? {} : { to: decodeActivityCursor(query.cursor) }),
      limit: limit + 1,
    });
    const shown = entries.slice(0, limit);
    const last = shown.at(-1);
    const urls = await activityUrls(deps.storage, shown);
    return {
      status: 200 as const,
      body: {
        data: shown.map((entry) => activityEntryView(entry, urls)),
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
    const explanation = await loadSaleExplanation(
      db,
      {
        accountId: tenant.accountId,
        saleId: params.saleId,
      },
      { forSeller: true },
    );
    if (explanation === undefined) throw notFound('Sale');
    const urls = await activityUrls(deps.storage, explanation.entries);
    return { status: 200, body: saleExplanationView(explanation, urls) };
  });
}

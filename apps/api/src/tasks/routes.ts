import type { DbTransaction } from '@listora/db';
import type { AdapterLookup } from '@listora/marketplaces';
import type { ObjectStorage } from '@listora/storage';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { notFound } from '../errors.ts';
import { decodeCursor, DEFAULT_PAGE_SIZE, encodeCursor } from '../pagination.ts';
import { completeUserTask, dismissUserTask } from './commands.ts';
import { findTask, listTaskRows } from './repository.ts';
import { STATUS_TO_DB, taskViews } from './views.ts';

export interface TaskRouteDependencies extends RouteDependencies {
  /** Photo URLs for the copy-assist photos and the item's cover. */
  storage: Pick<ObjectStorage, 'publicUrl'>;
  /** The adapters a confirmed sale email's auto-delist decides each delist with. */
  connections: { adapters: { lookup: AdapterLookup } };
}

/**
 * The task inbox (docs/features/tasks.md): `listTasks` (urgent first, then oldest first),
 * `getTask`, and `completeTask` and `dismissTask`, which finish the assisted operation a task
 * belongs to through the operation engine, so a confirmed step shows "you confirmed" and a
 * dismissed one fails with a Retry.
 */
export function registerTaskRoutes(app: FastifyInstance, deps: TaskRouteDependencies): void {
  contractRoute(app, deps, 'listTasks', async ({ tenant, db, query }) => {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const rows = await listTaskRows(db, tenant, {
      statuses: query.status?.map((status) => STATUS_TO_DB[status]),
      itemId: query.itemId,
      afterId: query.cursor === undefined ? undefined : decodeCursor(query.cursor),
      limit,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      status: 200,
      body: {
        data: await taskViews(db, tenant, page, deps.storage),
        ...(rows.length > limit && last ? { nextCursor: encodeCursor(last.id) } : {}),
      },
    };
  });

  contractRoute(app, deps, 'getTask', async ({ tenant, db, params }) => {
    const row = await findTask(db, tenant, params.taskId);
    if (!row) throw notFound('Task');
    const [view] = await taskViews(db, tenant, [row], deps.storage);
    if (view === undefined) throw notFound('Task');
    return { status: 200, body: view };
  });

  contractRoute(app, deps, 'completeTask', async ({ tenant, db, params, body }) => {
    const row = await completeUserTask(
      transaction(db),
      tenant,
      params.taskId,
      body,
      deps.connections.adapters.lookup,
    );
    const [view] = await taskViews(db, tenant, [row], deps.storage);
    if (view === undefined) throw notFound('Task');
    return { status: 200, body: view };
  });

  contractRoute(app, deps, 'dismissTask', async ({ tenant, db, params }) => {
    const row = await dismissUserTask(transaction(db), tenant, params.taskId);
    const [view] = await taskViews(db, tenant, [row], deps.storage);
    if (view === undefined) throw notFound('Task');
    return { status: 200, body: view };
  });
}

/** Every task change is an idempotent POST, which runs in the request's transaction. */
function transaction(db: RouteDependencies['db'] | DbTransaction): DbTransaction {
  if (!db.isTransaction) throw new Error("task changes must run in the request's transaction");
  return db as DbTransaction;
}

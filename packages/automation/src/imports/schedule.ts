/**
 * Where an import's pages are read (docs/features/imports.md): each page is its own browser
 * session where the connection runs, one after another. A connection that runs on the phone gets
 * the page as `listing_import` phone work (one at a time, behind routine changes); one in the
 * cloud gets the browser runner's job. Every read only reads.
 */
import { sql } from 'kysely';

import { addJob, type DbExecutor, type Marketplace } from '@listora/db';

/** The browser runner's task: read the next page of an import whose connection runs there. */
export const LISTING_IMPORT_READ_TASK = 'automation_listing_import';

/**
 * The worker's task: turn the import's entries into items (`@listora/imports`), after every
 * page, so items show up while later pages are read.
 */
export const LISTING_IMPORT_APPLY_TASK = 'listing_import_apply';

export interface ListingImportJobPayload {
  accountId: string;
  importId: string;
}

export function isListingImportJobPayload(value: unknown): value is ListingImportJobPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { accountId, importId } = value as Record<string, unknown>;
  return typeof accountId === 'string' && typeof importId === 'string';
}

/** An import's next page goes after routine changes and sale checks on the phone. */
const PHONE_IMPORT_PRIORITY = 10;

export interface ImportPageTarget {
  accountId: string;
  importId: string;
  connectionId: string;
  marketplace: Marketplace;
}

/**
 * Asks for the import's next page where its connection runs, `delayMs` from now. A page already
 * waiting keeps its time.
 */
export async function queueImportPage(
  executor: DbExecutor,
  target: ImportPageTarget,
  delayMs = 0,
): Promise<void> {
  const connection = await executor
    .selectFrom('marketplace_connection')
    .select('runs_on')
    .where('account_id', '=', target.accountId)
    .where('id', '=', target.connectionId)
    .executeTakeFirst();
  if (connection === undefined) return;
  if (connection.runs_on === 'phone') {
    await executor
      .insertInto('phone_work')
      .values({
        account_id: target.accountId,
        connection_id: target.connectionId,
        marketplace: target.marketplace,
        purpose: 'listing_import',
        import_id: target.importId,
        priority: PHONE_IMPORT_PRIORITY,
        due_at: sql<Date>`now() + make_interval(secs => ${delayMs / 1000})`,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['account_id', 'connection_id'])
          .where('purpose', '=', 'listing_import')
          .doNothing(),
      )
      .execute();
    return;
  }
  await addJob(executor, {
    task: LISTING_IMPORT_READ_TASK,
    payload: { accountId: target.accountId, importId: target.importId },
    jobKey: `listing-import-read:${target.importId}`,
    ...(delayMs > 0 ? { runAt: new Date(Date.now() + delayMs) } : {}),
  });
}

/** Asks the worker to settle the import's entries read so far. */
export async function queueImportApply(
  executor: DbExecutor,
  payload: ListingImportJobPayload,
): Promise<void> {
  await addJob(executor, {
    task: LISTING_IMPORT_APPLY_TASK,
    payload: { accountId: payload.accountId, importId: payload.importId },
    jobKey: `listing-import-apply:${payload.importId}`,
  });
}

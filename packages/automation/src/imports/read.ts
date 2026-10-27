/**
 * Reading an import's pages (docs/features/imports.md): one page of the seller's listings for
 * sale per browser session, through the marketplace's automation adapter (`listListings`),
 * read-only, where the connection runs. Each page's listings are kept as the import's entries,
 * the worker is asked to settle them, and the next page is asked for, until the marketplace
 * says there are no more. A page that could not be read ends the reading with the reason: the
 * listings read before it still import, and importing again reads from the start (listings
 * Listora already has settle at once).
 *
 * The browser runner runs `runImportPage`; the phone runs the same prepare and record around its
 * own run of the call (phone/work.ts).
 */
import { sql } from 'kysely';

import {
  inTransaction,
  jsonb,
  type DbExecutor,
  type JsonObject,
  type Marketplace,
} from '@listora/db';
import {
  MARKETPLACE_NAMES,
  type AdapterLookup,
  type ConnectionRef,
  type ListingsPage,
  type MarketplaceAdapter,
} from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import { AutomationReadError } from '../adapter/automation-adapter.ts';
import { queueImportApply, queueImportPage, type ListingImportJobPayload } from './schedule.ts';

export interface ImportReadDependencies {
  db: DbExecutor;
  adapters: AdapterLookup;
  logger: Logger;
  /** The deadline of one page's read (default 5 minutes). */
  timeoutMs?: number;
}

/** An import page ready to read. */
export interface PreparedImportPage {
  key: ListingImportJobPayload;
  marketplace: Marketplace;
  connection: ConnectionRef;
  adapter: MarketplaceAdapter & Required<Pick<MarketplaceAdapter, 'listListings'>>;
  connectionId: string;
  /** The page to read: `null` for the first. */
  cursor: string | null;
  runsOn: 'cloud' | 'phone';
}

/** How long a page waits when Listora is pacing its sessions in the seller's account. */
const PACED_RETRY_MS = 60_000;
/** Pages one import reads at most (some 2,400 to 4,800 listings), so a cursor loop ends. */
export const MAX_IMPORT_PAGES = 100;

/** The runner's job: reads the import's next page, unless its connection runs on the phone. */
export async function runImportPage(
  deps: ImportReadDependencies,
  payload: ListingImportJobPayload,
  signal: AbortSignal,
): Promise<void> {
  const prepared = await prepareImportPage(deps, payload);
  if (prepared === null) return;
  if (prepared.runsOn === 'phone') {
    // The connection's automated steps moved to the phone: its pages are read there now.
    await queueImportPage(deps.db, target(prepared));
    return;
  }
  let page: ListingsPage;
  try {
    page = await prepared.adapter.listListings(prepared.cursor, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(deps.timeoutMs ?? 300_000)]),
      connection: prepared.connection,
    });
  } catch (error) {
    await recordImportPageFailure(deps, prepared, error);
    return;
  }
  await recordImportPage(deps, prepared, page);
}

/**
 * The import's next page to read, or `null` when there is none now: the import is no longer
 * reading, or its connection can't be read (which ends the reading, with the reason).
 */
export async function prepareImportPage(
  deps: Pick<ImportReadDependencies, 'db' | 'adapters' | 'logger'>,
  payload: ListingImportJobPayload,
): Promise<PreparedImportPage | null> {
  const found = await deps.db
    .selectFrom('listing_import as import')
    .innerJoin('marketplace_connection as connection', (join) =>
      join
        .onRef('connection.account_id', '=', 'import.account_id')
        .onRef('connection.id', '=', 'import.connection_id'),
    )
    .select([
      'import.status',
      'import.cursor',
      'import.marketplace',
      'connection.id',
      'connection.mode',
      'connection.status as connectionStatus',
      'connection.runs_on',
    ])
    .where('import.account_id', '=', payload.accountId)
    .where('import.id', '=', payload.importId)
    .executeTakeFirst();
  if (found?.status !== 'reading') return null;
  const connection: ConnectionRef = {
    id: found.id,
    mode: found.mode,
    status: found.connectionStatus,
  };
  const adapter = deps.adapters(found.marketplace);
  const usable =
    found.mode === 'automation' &&
    (found.connectionStatus === 'connected' || found.connectionStatus === 'degraded');
  if (!usable || adapter?.listListings === undefined) {
    await stopReading(deps.db, payload, {
      code: usable ? 'unsupported' : 'no_session',
      message: usable
        ? `Listora can't read your ${MARKETPLACE_NAMES[found.marketplace]} listings yet.`
        : `Link ${MARKETPLACE_NAMES[found.marketplace]} again in Listora to finish the import.`,
    });
    return null;
  }
  return {
    key: payload,
    marketplace: found.marketplace,
    connection,
    adapter: adapter as PreparedImportPage['adapter'],
    connectionId: found.id,
    cursor: found.cursor,
    runsOn: found.runs_on,
  };
}

/**
 * Keeps the page's listings as the import's entries (a listing read twice, on two pages, once),
 * asks the worker to settle them, and asks for the next page, or ends the reading after the last.
 */
export async function recordImportPage(
  deps: Pick<ImportReadDependencies, 'db' | 'logger'>,
  prepared: PreparedImportPage,
  page: ListingsPage,
): Promise<void> {
  await inTransaction(deps.db, async (trx) => {
    const current = await trx
      .selectFrom('listing_import')
      .select(['status', 'cursor', 'pages_read'])
      .where('account_id', '=', prepared.key.accountId)
      .where('id', '=', prepared.key.importId)
      .forUpdate()
      .executeTakeFirst();
    // Another read recorded this page meanwhile (a lapsed claim run again): nothing to add.
    if (current?.status !== 'reading' || current.cursor !== prepared.cursor) return;
    const listings = page.listings.filter((listing) => listing.status === 'active');
    let added = 0;
    if (listings.length > 0) {
      const inserted = await trx
        .insertInto('listing_import_entry')
        .values(
          listings.map((listing) => ({
            account_id: prepared.key.accountId,
            import_id: prepared.key.importId,
            marketplace: prepared.marketplace,
            external_listing_id: listing.externalListingId,
            listing: jsonb(JSON.parse(JSON.stringify(listing)) as JsonObject),
          })),
        )
        .onConflict((conflict) =>
          conflict.columns(['account_id', 'import_id', 'external_listing_id']).doNothing(),
        )
        .returning('id')
        .execute();
      added = inserted.length;
    }
    const atLimit = page.next !== null && current.pages_read + 1 >= MAX_IMPORT_PAGES;
    const last = page.next === null || page.next === prepared.cursor || atLimit;
    await trx
      .updateTable('listing_import')
      .set({
        pages_read: sql<number>`pages_read + 1`,
        listings_read: sql<number>`listings_read + ${added}`,
        cursor: last ? prepared.cursor : page.next,
        ...(last ? { status: 'importing', read_at: sql<Date>`now()` } : {}),
        ...(atLimit
          ? {
              error_code: 'page_limit',
              error_message: `Listora read the newest ${String(MAX_IMPORT_PAGES)} pages of your ${MARKETPLACE_NAMES[prepared.marketplace]} listings, as many as one import reads.`,
            }
          : {}),
      })
      .where('account_id', '=', prepared.key.accountId)
      .where('id', '=', prepared.key.importId)
      .execute();
    await queueImportApply(trx, prepared.key);
    if (!last) await queueImportPage(trx, target(prepared));
    deps.logger.info(
      {
        event: 'listing_import_page',
        importId: prepared.key.importId,
        marketplace: prepared.marketplace,
        listings: listings.length,
        added,
        last,
      },
      'import page read',
    );
  });
}

/**
 * A page that could not be read. Listora pacing its sessions in the account only puts the page
 * off; anything else ends the reading with its reason, in the seller's words.
 */
export async function recordImportPageFailure(
  deps: Pick<ImportReadDependencies, 'db' | 'logger'>,
  prepared: PreparedImportPage,
  error: unknown,
): Promise<void> {
  const code = error instanceof AutomationReadError ? error.code : 'error';
  deps.logger.warn(
    {
      event: 'listing_import_page_failed',
      importId: prepared.key.importId,
      marketplace: prepared.marketplace,
      code,
      step: error instanceof AutomationReadError ? error.step : null,
      err: error instanceof Error ? { name: error.name, message: error.message } : error,
    },
    'import page not read',
  );
  if (code === 'automation_paced' || code === 'automation_busy') {
    await queueImportPage(deps.db, target(prepared), PACED_RETRY_MS);
    return;
  }
  await stopReading(deps.db, prepared.key, {
    code: code.slice(0, 100),
    message: importErrorMessage(code, prepared.marketplace),
  });
}

/** Ends the reading early with its reason; the entries read so far still import. */
async function stopReading(
  db: DbExecutor,
  key: ListingImportJobPayload,
  error: { code: string; message: string },
): Promise<void> {
  await inTransaction(db, async (trx) => {
    const updated = await trx
      .updateTable('listing_import')
      .set({
        status: 'importing',
        read_at: sql<Date>`now()`,
        error_code: error.code,
        error_message: error.message.slice(0, 500),
      })
      .where('account_id', '=', key.accountId)
      .where('id', '=', key.importId)
      .where('status', '=', 'reading')
      .executeTakeFirst();
    if (updated.numUpdatedRows > 0n) await queueImportApply(trx, key);
  });
}

/** The seller's words for why an import stopped reading. */
export function importErrorMessage(code: string, marketplace: Marketplace): string {
  const name = MARKETPLACE_NAMES[marketplace];
  switch (code) {
    case 'captcha':
    case 'bot_check':
    case 'login_challenge':
      return `${name} asked to check it's you, so Listora stopped reading. Link ${name} again, then import again to read the rest.`;
    case 'session_rejected':
      return `${name} signed Listora out, so it stopped reading. Link ${name} again, then import again to read the rest.`;
    case 'stopped_for_check':
      return `${name} wants you to complete a check in Listora on your iPhone. Import again once it's done to read the rest.`;
    case 'element_missing':
      return `${name}'s listings page has changed, so Listora couldn't read the rest.`;
    case 'rate_limited':
      return `${name} asked Listora to slow down. Import again later to read the rest.`;
    case 'step_timeout':
    case 'timeout':
      return `${name}'s pages took too long to load. Import again to read the rest.`;
    case 'server_error':
      return `${name} had a problem showing your listings. Import again to read the rest.`;
    case 'unreachable':
      return `Listora couldn't reach ${name}. Import again to read the rest.`;
    case 'no_session':
      return `Link ${name} again in Listora to finish the import.`;
    default:
      return `Listora couldn't read the rest of your ${name} listings. Import again to read them.`;
  }
}

function target(prepared: PreparedImportPage) {
  return {
    accountId: prepared.key.accountId,
    importId: prepared.key.importId,
    connectionId: prepared.connectionId,
    marketplace: prepared.marketplace,
  };
}

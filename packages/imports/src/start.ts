/**
 * Starting an import of the seller's listings on one marketplace (docs/features/imports.md): on
 * a marketplace Listora reads through a linked session, one import at a time per marketplace.
 * The first page is asked for where the connection runs (the phone, or the cloud runner).
 */
import { queueImportPage } from '@listora/automation';
import {
  inTransaction,
  type DbExecutor,
  type ListingImportTable,
  type Marketplace,
} from '@listora/db';
import { isFeatureVerified, MARKETPLACE_NAMES } from '@listora/marketplaces';
import type { Selectable } from 'kysely';

/**
 * The marketplaces whose listings Listora imports: their reads carry each listing's photos and
 * details. eBay's Seller Hub rows carry neither yet.
 */
export const IMPORT_MARKETPLACES = [
  'depop',
  'poshmark',
  'mercari',
] as const satisfies readonly Marketplace[];

/**
 * Whether Listora imports the marketplace's listings for sellers: one it can import from whose
 * imports passed live (docs/features/verified-features.md).
 */
export function importsFrom(marketplace: Marketplace): boolean {
  return (
    (IMPORT_MARKETPLACES as readonly string[]).includes(marketplace) &&
    isFeatureVerified(marketplace, 'listing_import')
  );
}

/** The marketplaces whose listings Listora imports for sellers, in `IMPORT_MARKETPLACES` order. */
export function importableMarketplaces(): Marketplace[] {
  return IMPORT_MARKETPLACES.filter(importsFrom);
}

export type ListingImportRow = Selectable<ListingImportTable>;

export type ImportRefusal = 'unsupported' | 'not_linked' | 'running';

/** Why an import can't start now, in the seller's words. */
export class ImportRefusedError extends Error {
  readonly code: ImportRefusal;
  /** The import under way, for `running`. */
  readonly importId: string | null;

  constructor(code: ImportRefusal, message: string, importId: string | null = null) {
    super(message);
    this.name = 'ImportRefusedError';
    this.code = code;
    this.importId = importId;
  }
}

/** Starts an import of the seller's listings for sale on `marketplace`. */
export async function startListingImport(
  executor: DbExecutor,
  request: { accountId: string; marketplace: Marketplace },
): Promise<ListingImportRow> {
  const name = MARKETPLACE_NAMES[request.marketplace];
  if (!importsFrom(request.marketplace)) {
    throw new ImportRefusedError('unsupported', `Listora can't import ${name} listings yet.`);
  }
  return inTransaction(executor, async (trx) => {
    const connection = await trx
      .selectFrom('marketplace_connection')
      .select(['id', 'mode', 'status', 'runs_on'])
      .where('account_id', '=', request.accountId)
      .where('marketplace', '=', request.marketplace)
      .where('mode', '=', 'automation')
      .forUpdate()
      .executeTakeFirst();
    if (
      connection === undefined ||
      (connection.status !== 'connected' && connection.status !== 'degraded')
    ) {
      throw new ImportRefusedError(
        'not_linked',
        `Link your ${name} account in Listora first, so it can read your listings.`,
      );
    }
    const running = await trx
      .selectFrom('listing_import')
      .select('id')
      .where('account_id', '=', request.accountId)
      .where('connection_id', '=', connection.id)
      .where('status', 'in', ['reading', 'importing'])
      .executeTakeFirst();
    if (running !== undefined) {
      throw new ImportRefusedError(
        'running',
        `Listora is already importing your ${name} listings.`,
        running.id,
      );
    }
    const created = await trx
      .insertInto('listing_import')
      .values({
        account_id: request.accountId,
        connection_id: connection.id,
        marketplace: request.marketplace,
        host: connection.runs_on === 'phone' ? 'phone' : 'runner',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await queueImportPage(trx, {
      accountId: request.accountId,
      importId: created.id,
      connectionId: connection.id,
      marketplace: request.marketplace,
    });
    return created;
  });
}

/**
 * Imports as the contract shows them (docs/features/imports.md): an import with its counts and
 * the server's words for where it is and what it did, the marketplaces an import can start on,
 * and the questions for the seller with the items each listing may be.
 */
import type {
  ListingImport,
  ListingImportCandidate,
  ListingImportMarketplace,
  ListingImportQuestion,
} from '@listora/api-contract';
import type { DbExecutor, ListingImportEntryTable } from '@listora/db';
import {
  importableMarketplaces,
  importWords,
  titleFrom,
  type ListingImportRow,
} from '@listora/imports';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import { parsePhotoDerivatives } from '@listora/photos';
import type { Selectable } from 'kysely';

import type { PublicUrls } from '../photos/mapping.ts';
import type { Tenant } from '../tenancy.ts';

/** The most questions one answer lists. */
export const MAX_QUESTIONS = 200;

export function importView(row: ListingImportRow): ListingImport {
  const words = importWords(row);
  return {
    id: row.id,
    marketplace: row.marketplace,
    status: row.status,
    runsOn: row.host === 'phone' ? 'phone' : 'cloud',
    counts: {
      read: row.listings_read,
      imported: row.imported,
      merged: row.merged,
      alreadyListed: row.already_listed,
      needsYou: row.needs_you,
      failed: row.failed,
    },
    progress: words.progress,
    ...(words.summary === null ? {} : { summary: words.summary }),
    ...(row.error_message === null ? {} : { stoppedReason: row.error_message }),
    startedAt: row.created_at.toISOString(),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at.toISOString() }),
  };
}

export async function findImport(
  db: DbExecutor,
  tenant: Tenant,
  importId: string,
): Promise<ListingImportRow | undefined> {
  return db
    .selectFrom('listing_import')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', importId)
    .executeTakeFirst();
}

/** Each marketplace Listora imports from: whether an import can start, and its newest one. */
export async function importMarketplaces(
  db: DbExecutor,
  tenant: Tenant,
): Promise<ListingImportMarketplace[]> {
  // Only marketplaces whose imports passed live (verified-features.md).
  const marketplaces = importableMarketplaces();
  if (marketplaces.length === 0) return [];
  const connections = await db
    .selectFrom('marketplace_connection')
    .select(['marketplace', 'mode', 'status'])
    .where('account_id', '=', tenant.accountId)
    .where('marketplace', 'in', marketplaces)
    .execute();
  const latest = await db
    .selectFrom('listing_import')
    .selectAll()
    .distinctOn('marketplace')
    .where('account_id', '=', tenant.accountId)
    .orderBy('marketplace')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return marketplaces.map((marketplace) => {
    const name = MARKETPLACE_NAMES[marketplace];
    const connection = connections.find((found) => found.marketplace === marketplace);
    const newest = latest.find((found) => found.marketplace === marketplace);
    const linked =
      connection?.mode === 'automation' &&
      (connection.status === 'connected' || connection.status === 'degraded');
    const running = newest !== undefined && newest.status !== 'finished';
    const unavailableReason = !linked
      ? `Link ${name} in Listora first, so it can read your listings.`
      : running
        ? `Listora is importing your ${name} listings now.`
        : null;
    return {
      marketplace,
      canStart: unavailableReason === null,
      ...(unavailableReason === null ? {} : { unavailableReason }),
      ...(newest === undefined ? {} : { latest: importView(newest) }),
    };
  });
}

type EntryRow = Selectable<ListingImportEntryTable>;

const WHY: Readonly<Record<Reason, string>> = {
  sku: 'Its SKU line names this item',
  photo_and_title: 'A photo and the title look the same',
  photo: 'A photo looks the same',
  title: 'The title is the same or nearly',
};

/** The import's open questions, oldest first, each with the items it may be. */
export async function importQuestions(
  db: DbExecutor,
  tenant: Tenant,
  importId: string,
  urls: PublicUrls,
): Promise<ListingImportQuestion[]> {
  const entries = await db
    .selectFrom('listing_import_entry')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('import_id', '=', importId)
    .where('outcome', '=', 'needs_you')
    .orderBy('id')
    .limit(MAX_QUESTIONS)
    .execute();
  const itemIds = [
    ...new Set(
      entries.flatMap((entry) => candidatesOf(entry).map((candidate) => candidate.itemId)),
    ),
  ];
  const items =
    itemIds.length === 0
      ? []
      : await db
          .selectFrom('inventory_item')
          .select(['id', 'sku', 'title'])
          .where('account_id', '=', tenant.accountId)
          .where('id', 'in', itemIds)
          .execute();
  const covers =
    itemIds.length === 0
      ? []
      : await db
          .selectFrom('photo')
          .select(['item_id', 'derivatives', 'status'])
          .where('account_id', '=', tenant.accountId)
          .where('item_id', 'in', itemIds)
          .where('position', '=', 0)
          .execute();
  const coverUrl = (itemId: string): string | null => {
    const cover = covers.find((photo) => photo.item_id === itemId);
    if (cover?.status !== 'ready') return null;
    const derivatives = parsePhotoDerivatives(cover.derivatives);
    return derivatives === undefined ? null : urls.publicUrl(derivatives.thumbnail.key);
  };
  return entries.flatMap((entry) => {
    const candidates = candidatesOf(entry).flatMap((candidate): ListingImportCandidate[] => {
      const item = items.find((found) => found.id === candidate.itemId);
      if (item === undefined) return [];
      const cover = coverUrl(item.id);
      return [
        {
          itemId: item.id,
          sku: item.sku,
          ...(item.title === null ? {} : { title: item.title }),
          ...(cover === null ? {} : { coverPhotoUrl: cover }),
          reason: candidate.reason,
          why: WHY[candidate.reason],
        },
      ];
    });
    // An item deleted since the question was asked is no longer one of its answers.
    if (candidates.length === 0) return [];
    return [questionView(entry, candidates)];
  });
}

function questionView(
  entry: EntryRow,
  candidates: ListingImportCandidate[],
): ListingImportQuestion {
  const listing = entry.listing as {
    title?: unknown;
    description?: unknown;
    externalUrl?: unknown;
    priceCents?: unknown;
    details?: { photoUrls?: unknown };
  };
  const title =
    typeof listing.title === 'string' && listing.title !== ''
      ? listing.title
      : typeof listing.description === 'string'
        ? titleFrom(listing.description)
        : null;
  const photos: unknown = listing.details?.photoUrls;
  const photo: unknown = Array.isArray(photos) ? photos[0] : undefined;
  return {
    id: entry.id,
    marketplace: entry.marketplace,
    externalListingId: entry.external_listing_id,
    ...(typeof listing.externalUrl === 'string' ? { externalUrl: listing.externalUrl } : {}),
    ...(title === null ? {} : { title }),
    ...(typeof listing.priceCents === 'number'
      ? { price: { amountCents: listing.priceCents, currency: 'USD' } }
      : {}),
    ...(typeof photo === 'string' ? { photoUrl: photo } : {}),
    candidates: candidates.slice(0, 3),
  };
}

type Reason = ListingImportCandidate['reason'];
const REASONS: readonly Reason[] = ['sku', 'photo_and_title', 'photo', 'title'];

function candidatesOf(entry: EntryRow): { itemId: string; reason: Reason }[] {
  return (entry.candidates as unknown[]).flatMap((candidate) => {
    const { itemId, reason } = (candidate ?? {}) as { itemId?: unknown; reason?: unknown };
    const known = REASONS.find((value) => value === reason);
    return typeof itemId === 'string' && known !== undefined ? [{ itemId, reason: known }] : [];
  });
}

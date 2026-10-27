/**
 * What the app says about an import (docs/features/imports.md), in the seller's words, from its
 * counts: where it is ("Reading your Depop listings on your iPhone... 48 so far", "Importing 12
 * of 42") and, once done, what it did ("Imported 42 from Depop, 3 need you").
 */
import { MARKETPLACE_NAMES } from '@listora/marketplaces';

import type { ListingImportRow } from './start.ts';

export interface ImportWords {
  /** Where the import is now. */
  progress: string;
  /** What it did; `null` while it reads. */
  summary: string | null;
}

export function importWords(row: ListingImportRow): ImportWords {
  const name = MARKETPLACE_NAMES[row.marketplace];
  const settled = row.imported + row.merged + row.already_listed + row.needs_you + row.failed;
  switch (row.status) {
    case 'reading': {
      const where = row.host === 'phone' ? 'on your iPhone' : 'in the cloud';
      const sofar = row.listings_read === 0 ? '' : `... ${String(row.listings_read)} so far`;
      return { progress: `Reading your ${name} listings ${where}${sofar}`, summary: null };
    }
    case 'importing':
      return {
        progress: `Importing ${String(Math.min(settled, row.listings_read))} of ${String(row.listings_read)}`,
        summary: summary(row, name),
      };
    case 'finished':
      return { progress: 'Done', summary: summary(row, name) };
  }
}

function summary(row: ListingImportRow, name: string): string {
  const imported = row.imported + row.merged;
  if (row.listings_read === 0) {
    return row.error_message === null
      ? `No listings for sale on ${name}`
      : `Nothing imported from ${name}`;
  }
  const parts = [`Imported ${String(imported)} from ${name}`];
  if (row.needs_you > 0)
    parts.push(`${String(row.needs_you)} need${row.needs_you === 1 ? 's' : ''} you`);
  if (row.already_listed > 0) parts.push(`${String(row.already_listed)} already in Listora`);
  if (row.failed > 0) parts.push(`${String(row.failed)} couldn't be imported`);
  return parts.join(', ');
}

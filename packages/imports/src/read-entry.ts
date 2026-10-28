/**
 * An entry's listing as the import read it (`listing_import_entry.listing`, a `ListedListing`),
 * checked back into its type: the phone's answer was checked before it was stored, so a row
 * that no longer reads is Listora's own fault, and the entry fails rather than importing it.
 */
import { z } from 'zod';

import type { JsonObject } from '@listora/db';
import {
  ITEM_CONDITIONS,
  REMOTE_LISTING_STATUSES,
  type ListedListing,
} from '@listora/marketplaces';

const listedListingSchema = z.object({
  found: z.literal(true),
  externalListingId: z.string().min(1),
  externalUrl: z.string().nullable(),
  status: z.enum(REMOTE_LISTING_STATUSES),
  title: z.string().nullable(),
  description: z.string().nullable(),
  priceCents: z.number().int().min(0).nullable(),
  currency: z.literal('USD').nullable(),
  revision: z.number().int().min(0).nullable(),
  // Entries stored before refreshes were read have none.
  refreshedAt: z.string().nullable().default(null),
  details: z.object({
    photoUrls: z.array(z.string()),
    brand: z.string().nullable(),
    size: z.string().nullable(),
    condition: z.enum(ITEM_CONDITIONS).nullable(),
    categoryRef: z.string().nullable(),
    categoryPath: z.array(z.string()),
    sku: z.string().nullable(),
  }),
});

export function listedListing(stored: JsonObject): ListedListing | null {
  const parsed = listedListingSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

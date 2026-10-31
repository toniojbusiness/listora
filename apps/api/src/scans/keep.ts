import type { ItemDetails } from '@listora/api-contract';
import type { ThriftScan } from '@listora/analysis';
import type { DbTransaction, InventoryItem } from '@listora/db';

import { writeAudit } from '../audit.ts';
import {
  changedDetails,
  columnsFromDetails,
  detailsFromRow,
  normalizeDetails,
  type FieldProvenance,
} from '../items/details.ts';
import { insertItem } from '../items/repository.ts';
import { assertValidDetails, translateWriteError } from '../items/routes.ts';
import { countScan } from '../sourcing-runs/repository.ts';
import type { Tenant } from '../tenancy.ts';
import { markKept, type ItemScanRow } from './repository.ts';

/**
 * Keeps an open scan of an open run as a draft item, with the details the AI read (provenance
 * `ai`), and counts it kept on its run: `keepScan`'s, and a checkout's for a kept scan the app
 * had not sent yet. The caller holds the scan's lock, then the run's, and has checked both.
 */
export async function keepAsItem(
  trx: DbTransaction,
  tenant: Tenant,
  scan: ItemScanRow,
): Promise<InventoryItem> {
  const details = normalizeDetails(keptDetails(scan.read as unknown as ThriftScan));
  await assertValidDetails(trx, tenant, undefined, details);
  let item: InventoryItem;
  try {
    // Every detail is the scan's read until the seller changes it.
    const provenance: FieldProvenance = Object.fromEntries(
      Object.keys(details).map((key) => [key, 'ai' as const]),
    );
    item = await insertItem(trx, tenant, columnsFromDetails(details), provenance);
  } catch (error) {
    throw translateWriteError(error);
  }
  await writeAudit(trx, tenant, {
    itemId: item.id,
    action: 'item.created',
    changes: {
      sku: item.sku,
      scanId: scan.id,
      runId: scan.run_id,
      ...changedDetails({}, detailsFromRow(item)),
    },
  });
  await markKept(trx, tenant, scan.id, item.id);
  await countScan(trx, tenant, scan.run_id, 'kept');
  return item;
}

/** A kept scan's details: what the AI read, nothing it could not tell. */
export function keptDetails(read: ThriftScan): Partial<ItemDetails> {
  const item = read.item.trim();
  const brand = read.brand?.trim() ?? '';
  const named = item.toLowerCase().startsWith(brand.toLowerCase()) ? item : `${brand} ${item}`;
  const title = (named.charAt(0).toUpperCase() + named.slice(1)).slice(0, 200).trim();
  return {
    title,
    ...(read.brand === null ? {} : { brand: read.brand }),
    ...(read.category === null ? {} : { category: read.category }),
    ...(read.department === null ? {} : { department: read.department }),
    ...(read.sizeLabel === null ? {} : { sizeLabel: read.sizeLabel }),
    ...(read.condition === null ? {} : { condition: read.condition }),
  };
}

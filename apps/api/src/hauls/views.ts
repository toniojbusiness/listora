import type { Haul } from '@listora/api-contract';
import type { DbExecutor } from '@listora/db';

import type { Tenant } from '../tenancy.ts';
import { findHaul, haulMemberCounts, type HaulRow } from './repository.ts';
import { eachCostCents } from './shares.ts';

/** The contract's `Haul` for a row and the number of items in it. */
export function haulView(row: HaulRow, itemsAdded: number): Haul {
  return {
    id: row.id,
    total: { amountCents: row.total_cents, currency: row.currency },
    itemCount: row.item_count,
    itemsAdded,
    eachCost: {
      amountCents: eachCostCents(row.total_cents, row.item_count),
      currency: row.currency,
    },
    ...(row.purchase_date === null ? {} : { purchaseDate: row.purchase_date }),
    ...(row.purchase_source === null ? {} : { purchaseSource: row.purchase_source }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The haul with how many items it has now. */
export async function loadHaulView(db: DbExecutor, tenant: Tenant, haul: HaulRow): Promise<Haul> {
  const counts = await haulMemberCounts(db, tenant, [haul.id]);
  return haulView(haul, counts.get(haul.id) ?? 0);
}

/** The view of the haul an item is part of; undefined when it is in none. */
export async function itemHaulView(
  db: DbExecutor,
  tenant: Tenant,
  haulId: string | null,
): Promise<Haul | undefined> {
  if (haulId === null) return undefined;
  const haul = await findHaul(db, tenant, haulId);
  return haul === undefined ? undefined : loadHaulView(db, tenant, haul);
}

/**
 * The listing content a create, revise, or relist publishes (`ListingContent` in
 * `@listora/marketplaces`): the item as it is now and the listing's variant. The operation
 * stores it, so a later edit of the item never changes a publish already in flight.
 */
import type { ListingVariant } from '@listora/api-contract';
import type { DbExecutor, InventoryItem } from '@listora/db';
import {
  ITEM_CONDITIONS,
  type ItemCondition,
  type ItemSnapshot,
  type ListingContent,
  type ListingPhoto,
} from '@listora/marketplaces';

import { detailsFromRow } from '../items/details.ts';
import { photoFromRow, type PublicUrls } from '../photos/mapping.ts';
import { listPhotoRows } from '../photos/repository.ts';
import type { Tenant } from '../tenancy.ts';

function itemCondition(value: string | null | undefined): ItemCondition | null {
  return ITEM_CONDITIONS.find((condition) => condition === value) ?? null;
}

/**
 * The item's canonical attributes and its ready photos' listing images, in posting order. A
 * photo still processing (or failed) has no listing image yet, so it is left out.
 */
export async function itemSnapshot(
  db: DbExecutor,
  tenant: Tenant,
  item: InventoryItem,
  urls: PublicUrls,
): Promise<ItemSnapshot> {
  const details = detailsFromRow(item);
  const photos: ListingPhoto[] = (await listPhotoRows(db, tenant, item.id)).flatMap((row) => {
    const photo = photoFromRow(row, urls);
    return photo.urls === undefined
      ? []
      : [{ photoId: photo.id, position: photo.position, role: row.role, url: photo.urls.listing }];
  });
  return {
    itemId: item.id,
    sku: item.sku,
    brand: details.brand ?? null,
    productName: details.productName ?? null,
    styleNumber: details.styleNumber ?? null,
    upc: details.upc ?? null,
    department: details.department ?? null,
    category: details.category ?? null,
    sizeLabel: details.sizeLabel ?? null,
    sizeSystem: details.sizeSystem ?? null,
    colors: details.colors ?? [],
    pattern: details.pattern ?? null,
    materials: details.materials ?? [],
    condition: itemCondition(details.condition),
    conditionNotes: details.conditionNotes ?? null,
    flaws: details.flaws ?? [],
    measurements: (details.measurements ?? []).map(({ name, value, unit }) => ({
      name,
      value,
      unit,
    })),
    photos,
  };
}

/** The content to publish: the item now, and the variant in Listora's terms. */
export async function listingContent(
  db: DbExecutor,
  tenant: Tenant,
  item: InventoryItem,
  variant: ListingVariant,
  urls: PublicUrls,
): Promise<ListingContent> {
  return {
    item: await itemSnapshot(db, tenant, item, urls),
    variant: {
      title: variant.title,
      description: variant.description,
      price: { amountCents: variant.price.amountCents, currency: variant.price.currency },
      categoryRef: variant.categoryRef ?? null,
      condition: itemCondition(variant.condition),
      aspects: (variant.aspects ?? []).map(({ name, values }) => ({ name, values: [...values] })),
      hashtags: variant.hashtags ?? [],
    },
  };
}

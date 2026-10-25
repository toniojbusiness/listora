/**
 * The contract's `UserTask`: what the user does by hand on a marketplace, worded for the task
 * inbox. The copy-assist comes from the task's payload, which the assisted adapter wrote when
 * the step became the user's (title, description, price, photos in posting order); photos are
 * served as the contract's `Photo`, with the URLs they have now.
 */
import type { CopyField, Photo, UserTask, UserTaskStatus } from '@listora/api-contract';
import type {
  DbExecutor,
  Marketplace,
  OperationKind,
  UserTaskStatus as TaskStatus,
} from '@listora/db';
import { MARKETPLACES } from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';

import { photoFromRow, type PhotoRow, type PublicUrls } from '../photos/mapping.ts';
import type { Tenant } from '../tenancy.ts';
import { coverPhotoRows, photoRowsById, type TaskRow } from './repository.ts';

/** The contract's task statuses and the database's: a confirmed task is `done` in the table. */
export const STATUS_TO_DB = {
  open: 'open',
  completed: 'done',
  dismissed: 'dismissed',
} as const satisfies Record<UserTaskStatus, TaskStatus>;

const STATUS_FROM_DB = {
  open: 'open',
  done: 'completed',
  dismissed: 'dismissed',
} as const satisfies Record<TaskStatus, UserTaskStatus>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What an assisted step's payload holds (`AssistedAdapter` in @listora/marketplaces). */
interface CopyAssistPayload {
  title?: string;
  description?: string;
  price?: { amountCents: number; currency: string };
  photos?: { photoId: string; url: string }[];
}

/** The task views of rows, loading the photos they show in two queries. */
export async function taskViews(
  db: DbExecutor,
  tenant: Tenant,
  rows: readonly TaskRow[],
  urls: PublicUrls,
): Promise<UserTask[]> {
  const copyAssists = rows.map((row) => copyAssistOf(row));
  const photoIds = copyAssists.flatMap((copy) =>
    (copy?.photos ?? []).map(({ photoId }) => photoId).filter((id) => UUID.test(id)),
  );
  const itemIds = [...new Set(rows.flatMap((row) => (row.item_id === null ? [] : [row.item_id])))];
  const [photos, covers] = await Promise.all([
    photoRowsById(db, tenant, [...new Set(photoIds)]),
    coverPhotoRows(db, tenant, itemIds),
  ]);
  const photoById = new Map(photos.map((photo) => [photo.id, photo]));
  const coverByItem = new Map(covers.map((photo) => [photo.item_id, photo]));
  return rows.map((row, index) =>
    taskView(row, copyAssists[index], { photoById, coverByItem, urls }),
  );
}

interface PhotoLookup {
  photoById: Map<string, PhotoRow>;
  coverByItem: Map<string, PhotoRow>;
  urls: PublicUrls;
}

function taskView(
  row: TaskRow,
  copy: CopyAssistPayload | undefined,
  photos: PhotoLookup,
): UserTask {
  const marketplace = marketplaceOf(row) ?? undefined;
  const cover = row.item_id === null ? undefined : photos.coverByItem.get(row.item_id);
  const { title, instructions } = wording(row);
  const copyAssist = copy === undefined ? undefined : copyAssistView(copy, photos);
  return {
    id: row.id,
    kind: row.kind,
    status: STATUS_FROM_DB[row.status],
    urgency: row.urgency === 'urgent' ? 'urgent' : 'normal',
    title,
    instructions,
    ...(marketplace === undefined ? {} : { marketplace }),
    ...(row.item_id === null ? {} : { itemId: row.item_id }),
    ...(row.item_id === null || row.item_sku === null
      ? {}
      : {
          item: {
            id: row.item_id,
            sku: row.item_sku,
            ...(row.item_title === null ? {} : { title: row.item_title }),
            ...(cover === undefined ? {} : { coverPhoto: photoFromRow(cover, photos.urls) }),
          },
        }),
    ...(row.listing_id === null ? {} : { listingId: row.listing_id }),
    ...(row.operation_id === null ? {} : { operationId: row.operation_id }),
    ...(row.sale_id === null ? {} : { saleId: row.sale_id }),
    ...(row.deep_link === null ? {} : { deepLink: row.deep_link }),
    ...(copyAssist === undefined ? {} : { copyAssist }),
    createdAt: row.created_at.toISOString(),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at.toISOString() }),
  };
}

function payloadObject(row: TaskRow): Record<string, unknown> {
  const payload = row.payload;
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload : {};
}

/** The listing's marketplace, or for a task without a listing the one its payload names. */
function marketplaceOf(row: TaskRow): Marketplace | null {
  if (row.marketplace !== null) return row.marketplace;
  const named = payloadObject(row)['marketplace'];
  return MARKETPLACES.find((marketplace) => marketplace === named) ?? null;
}

function copyAssistOf(row: TaskRow): CopyAssistPayload | undefined {
  const copy = payloadObject(row)['copyAssist'];
  if (typeof copy !== 'object' || copy === null || Array.isArray(copy)) return undefined;
  return copy;
}

/**
 * One-tap copy fields in the order the marketplace's form asks for them, and the photos in
 * posting order. A photo deleted since the task was made is left out.
 */
function copyAssistView(copy: CopyAssistPayload, photos: PhotoLookup): UserTask['copyAssist'] {
  const fields: CopyField[] = [];
  if (copy.title !== undefined) fields.push({ label: 'Title', value: copy.title });
  if (copy.description !== undefined && copy.description !== '') {
    fields.push({ label: 'Description', value: copy.description });
  }
  if (copy.price !== undefined) fields.push({ label: 'Price', value: amount(copy.price) });
  const ordered: Photo[] = (copy.photos ?? []).flatMap(({ photoId }) => {
    const row = photos.photoById.get(photoId);
    return row?.status === 'ready' ? [photoFromRow(row, photos.urls)] : [];
  });
  return { fields, photos: ordered };
}

/** "39.00": what the user types into a marketplace's price field (USD only for now). */
function amount(price: { amountCents: number }): string {
  const cents = Math.abs(price.amountCents);
  return `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
}

/** The task's title and instructions, by its kind and the step it finishes. */
function wording(row: TaskRow): { title: string; instructions: string } {
  const marketplace = marketplaceOf(row);
  const name = marketplace === null ? 'the marketplace' : MARKETPLACE_NAMES[marketplace];
  switch (row.kind) {
    case 'list_manually':
      return listWording(row.operation_kind, name);
    case 'edit_manually':
      return row.operation_kind === 'price'
        ? {
            title: `Change the price on ${name}`,
            instructions: `Open the listing in the ${name} app, set the new price, and save it. Then tap Done.`,
          }
        : {
            title: `Update the listing on ${name}`,
            instructions: `Open the listing in the ${name} app, paste in the new details, and save it. Then tap Done.`,
          };
    case 'delist_manually':
      return {
        title: delistTitle(row.sold_on, name),
        instructions: `Open the listing in the ${name} app and delete it or mark it sold. Then tap Done.`,
      };
    case 'confirm_sale':
      return {
        title: `Confirm a sale on ${name}`,
        instructions: 'Check that the sale is right, then confirm it.',
      };
    case 'reconnect':
      return {
        title: `Reconnect ${name}`,
        instructions: `Listora can't reach your ${name} account. Reconnect it in Settings > Marketplaces.`,
      };
    case 'resolve_double_sale': {
      // The auto-delist orchestrator wrote the marketplace's own cancel steps (orderCancelGuide).
      const payload = payloadObject(row);
      const title =
        typeof payload['title'] === 'string'
          ? payload['title']
          : `Sold twice - cancel the ${name} order`;
      const steps = Array.isArray(payload['steps'])
        ? payload['steps'].filter((step): step is string => typeof step === 'string')
        : [];
      return {
        title,
        instructions: [
          `This item sold twice. Cancel the second order on ${name}, then tap Done.`,
          ...steps.map((step, index) => `${String(index + 1)}. ${step}`),
        ].join('\n'),
      };
    }
    case 'review_match':
      return {
        title: `Check a ${name} listing`,
        instructions:
          'Listora found a listing that may be one of your items. Check whether it matches.',
      };
    default:
      return {
        title: `Action needed on ${name}`,
        instructions: 'Update Listora to finish this task.',
      };
  }
}

function listWording(kind: OperationKind | null, name: string) {
  const verb = kind === 'relist' ? 'Relist' : 'List';
  return {
    title: `${verb} on ${name}`,
    instructions: `Save the photos, copy the details into the ${name} app, and post the listing. Then paste the listing's link here and tap Done.`,
  };
}

function delistTitle(soldOn: Marketplace | null, name: string): string {
  return soldOn === null
    ? `Delist on ${name}`
    : `Sold on ${MARKETPLACE_NAMES[soldOn]} - delist on ${name}`;
}

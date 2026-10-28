import type { PackItem, PackOrder, PackScan, StatusDisplay } from '@listora/api-contract';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import {
  ago,
  describeItem,
  trackingTail,
  verdictWords,
  type CheckedScan,
  type PackOrderRecord,
} from '@listora/pack-check';
import type { ObjectStorage } from '@listora/storage';

import { photoFromRow, type PhotoRow } from '../photos/mapping.ts';

const CARRIER_NAMES = {
  usps: 'USPS',
  ups: 'UPS',
  fedex: 'FedEx',
  dhl: 'DHL',
  other: 'Label',
} as const;

export interface PackViewContext {
  covers: ReadonlyMap<string, PhotoRow>;
  storage: ObjectStorage;
  /** The package photos' signed read URLs, by key (`packPhotoUrls`). */
  packPhotoUrls: ReadonlyMap<string, string>;
  /** Whether a label read is waiting for the phone, per marketplace. */
  reading: ReadonlySet<string>;
  now: Date;
}

/** The contract's `PackOrder`. */
export function packOrderView(order: PackOrderRecord, context: PackViewContext): PackOrder {
  const items = order.items.map((item): PackItem => {
    const cover = context.covers.get(item.itemId);
    const urls = cover === undefined ? undefined : photoFromRow(cover, context.storage).urls;
    const title = item.title?.trim() ?? '';
    const size = item.sizeLabel?.trim() ?? '';
    return {
      itemId: item.itemId,
      sku: item.sku,
      description: describeItem(item),
      ...(title === '' ? {} : { title: title.slice(0, 200) }),
      ...(size === '' ? {} : { sizeLabel: size.slice(0, 100) }),
      ...(item.location === null
        ? {}
        : {
            location: {
              code: item.location.code,
              ...(item.location.label === null ? {} : { label: item.location.label }),
            },
          }),
      ...(urls?.thumbnail === undefined ? {} : { thumbnailUrl: urls.thumbnail }),
      ...(urls?.listing === undefined ? {} : { photoUrl: urls.listing }),
    };
  });
  const pack = order.pack;
  const packPhotoUrl =
    pack?.photoKey == null ? undefined : context.packPhotoUrls.get(pack.photoKey);
  return {
    saleId: order.saleId,
    marketplace: order.marketplace,
    ...(order.externalOrderId === null
      ? {}
      : { orderNumber: displayOrderNumber(order.externalOrderId) }),
    soldAt: order.soldAt.toISOString(),
    ...(order.shipBy === null ? {} : { shipBy: order.shipBy.toISOString() }),
    description: order.description,
    ...(order.buyerFirstName === null ? {} : { buyerFirstName: order.buyerFirstName }),
    items,
    ...(order.label === null
      ? {}
      : {
          label: {
            trackingNumber: order.label.trackingNumber,
            carrier: order.label.carrier,
            source: order.label.source,
          },
        }),
    labelStatus: labelStatus(order, context),
    ...(pack === null
      ? {}
      : {
          pack: {
            packedAt: pack.packedAt.toISOString(),
            trackingNumber: pack.trackingNumber,
            matchedBy: pack.matchedBy,
            ...(pack.stickerSku === null ? {} : { stickerSku: pack.stickerSku }),
            labelMismatch: labelMismatch(order),
            ...(packPhotoUrl === undefined ? {} : { photoUrl: packPhotoUrl }),
            ...(pack.photoAddedAt === null
              ? {}
              : { photoAddedAt: pack.photoAddedAt.toISOString() }),
          },
        }),
    packStatus: packStatus(order, context.now),
  };
}

/** Poshmark's sale checks name an order by its listing (`listing:<id>`): show the id alone. */
function displayOrderNumber(externalOrderId: string): string {
  return externalOrderId.replace(/^listing:/, '').slice(0, 200);
}

/** The label the marketplace shows now differs from the one the package got. */
function labelMismatch(order: PackOrderRecord): boolean {
  const { pack, label } = order;
  if (pack === null || label?.source !== 'marketplace') return false;
  return (
    !pack.trackingNumber.endsWith(label.trackingNumber) &&
    !label.trackingNumber.endsWith(pack.trackingNumber)
  );
}

/** The order's label in words: what Listora has, or where its read stands. */
function labelStatus(order: PackOrderRecord, context: PackViewContext): StatusDisplay {
  const name = MARKETPLACE_NAMES[order.marketplace];
  if (order.label !== null) {
    const carrier = CARRIER_NAMES[order.label.carrier];
    const from = order.label.source === 'marketplace' ? `from ${name}` : 'you scanned it';
    return {
      tone: 'neutral',
      label: `${carrier} ${trackingTail(order.label.trackingNumber)} (${from})`,
    };
  }
  if (context.reading.has(order.marketplace)) {
    return { tone: 'neutral', label: `Reading the label from ${name} on your iPhone...` };
  }
  switch (order.read?.status) {
    case 'no_label':
      return { tone: 'action_needed', label: `No label on ${name} yet` };
    case 'not_found':
      return {
        tone: 'action_needed',
        label: `Listora couldn't find this order on ${name} - scan its label`,
      };
    case 'failed':
      return { tone: 'action_needed', label: `Listora couldn't read ${name} - scan the label` };
    case 'read':
    case undefined:
      return { tone: 'neutral', label: 'No label yet - scan it when you pack' };
  }
}

function packStatus(order: PackOrderRecord, now: Date): StatusDisplay {
  const { pack } = order;
  if (pack === null) return { tone: 'neutral', label: 'Not packed' };
  if (labelMismatch(order)) {
    return {
      tone: 'failed',
      label: `Check this package: ${MARKETPLACE_NAMES[order.marketplace]} shows another label`,
    };
  }
  const how =
    pack.matchedBy === 'sticker'
      ? 'label and sticker matched'
      : pack.matchedBy === 'label'
        ? 'label matched'
        : 'you checked the photo';
  return { tone: 'success', label: `Packed ${ago(pack.packedAt, now)} (${how})` };
}

/** The contract's `PackScan`. */
export function packScanView(checked: CheckedScan, context: PackViewContext): PackScan {
  const { verdict } = checked;
  const words = verdictWords(verdict, context.now);
  const view = (saleId: string | undefined): PackOrder | undefined => {
    const record = saleId === undefined ? undefined : checked.orders.get(saleId);
    return record === undefined ? undefined : packOrderView(record, context);
  };
  let order: PackOrder | undefined;
  let expected: PackOrder | undefined;
  let packed: PackOrder | undefined;
  switch (verdict.verdict) {
    case 'match':
    case 'found':
      order = view(verdict.order.saleId);
      break;
    case 'wrong_order':
      order = view(verdict.order.saleId);
      expected = view(verdict.expected.saleId);
      break;
    case 'already_packed':
      packed = view(verdict.packed.order.saleId);
      expected = view(verdict.expected?.saleId);
      break;
    case 'sticker_mismatch':
      order = view(verdict.sticker?.saleId);
      expected = view(verdict.order.saleId);
      break;
    case 'unknown_label':
      expected = view(verdict.expected?.saleId);
      break;
    case 'sticker_scanned':
      order = view(verdict.order?.saleId);
      break;
    case 'not_a_label':
      break;
  }
  return {
    verdict: verdict.verdict,
    tone: words.tone,
    headline: words.headline.slice(0, 300),
    detail: words.detail.slice(0, 500),
    ...(checked.trackingNumber === null ? {} : { trackingNumber: checked.trackingNumber }),
    ...(order === undefined ? {} : { order }),
    ...(expected === undefined ? {} : { expectedOrder: expected }),
    ...(packed === undefined ? {} : { packedOrder: packed }),
    canPack: verdict.verdict === 'match',
    canPhotoCheck:
      verdict.verdict === 'unknown_label' &&
      verdict.expected !== null &&
      checked.trackingNumber !== null,
  };
}

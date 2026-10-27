/**
 * A scan at the packing table, checked against the account's orders (verdict.ts has the rules):
 * the scanned label's tracking number, the item sticker's SKU, and the order being packed, read
 * from the database. Only reads: packing an order is `packOrder` (pack.ts).
 */
import type { DbExecutor } from '@listora/db';

import {
  loadPackOrdersById,
  openSalesWithLabel,
  openSaleWithSku,
  packWithLabel,
  verdictOrder,
  type PackOrderRecord,
} from './orders.ts';
import { stickerSku } from './sticker.ts';
import { canonicalTracking } from './tracking.ts';
import { scanVerdict, type ScanFacts, type ScanVerdict } from './verdict.ts';

export interface ScanInput {
  /** What the camera read from the shipping label (or the number the seller typed). */
  label?: string | undefined;
  /** What the camera read from the item's sticker. */
  sticker?: string | undefined;
  /** The order being packed. */
  saleId?: string | undefined;
}

export interface CheckedScan {
  verdict: ScanVerdict;
  /** The label's canonical tracking number, when the label code can be one. */
  trackingNumber: string | null;
  /** Every order the verdict names, by sale id, for the views. */
  orders: ReadonlyMap<string, PackOrderRecord>;
}

/** The order being packed was not found: another account's, or not a sale. */
export class PackOrderNotFoundError extends Error {
  constructor() {
    super('That order was not found.');
    this.name = 'PackOrderNotFoundError';
  }
}

/** Checks a scan; throws `PackOrderNotFoundError` when `saleId` is not the account's sale. */
export async function checkScan(
  executor: DbExecutor,
  accountId: string,
  input: ScanInput,
): Promise<CheckedScan> {
  const rawLabel = input.label?.trim() ?? '';
  const labelSku = rawLabel === '' ? null : stickerSku(rawLabel);
  const tracking = rawLabel === '' || labelSku !== null ? null : canonicalTracking(rawLabel);
  const rawSticker = input.sticker?.trim() ?? '';
  const sku = labelSku ?? (rawSticker === '' ? null : stickerSku(rawSticker));

  const [labelSales, packed, stickerSale] = await Promise.all([
    tracking === null ? [] : openSalesWithLabel(executor, accountId, tracking),
    tracking === null ? undefined : packWithLabel(executor, accountId, tracking),
    sku === null ? undefined : openSaleWithSku(executor, accountId, sku),
  ]);
  const ids = new Set([
    ...labelSales,
    ...(packed === undefined ? [] : [packed.saleId]),
    ...(stickerSale === undefined ? [] : [stickerSale]),
    ...(input.saleId === undefined ? [] : [input.saleId]),
  ]);
  const records = await loadPackOrdersById(executor, accountId, [...ids]);
  const orders = new Map(records.map((record) => [record.saleId, record]));
  const expectedRecord = input.saleId === undefined ? undefined : orders.get(input.saleId);
  if (input.saleId !== undefined && expectedRecord === undefined) {
    throw new PackOrderNotFoundError();
  }
  const named = (saleId: string | undefined) => {
    const record = saleId === undefined ? undefined : orders.get(saleId);
    return record === undefined ? null : verdictOrder(record);
  };
  const packedOrder = named(packed?.saleId);
  const facts: ScanFacts = {
    label: tracking,
    labelUnreadable: rawLabel !== '' && labelSku === null && tracking === null,
    labelIsSticker: labelSku !== null,
    stickerSku: sku,
    expected: expectedRecord === undefined ? null : verdictOrder(expectedRecord),
    labelOrders: labelSales.flatMap((saleId) => named(saleId) ?? []),
    packed: packed === undefined || packedOrder === null ? null : { order: packedOrder, packedAt: packed.packedAt },
    stickerOrder: named(stickerSale),
  };
  return { verdict: scanVerdict(facts), trackingNumber: tracking, orders };
}

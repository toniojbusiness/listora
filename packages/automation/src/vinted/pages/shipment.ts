/**
 * Pack check's part of a Vinted order (docs/features/vinted.md, "Shipping labels and Pack
 * check"): the shipment of one order as its web API read shows it (`GET /api/v2/transactions/<id>`,
 * `pages/api.ts`), only read.
 *
 * On Vinted the buyer picks the carrier (USPS, FedEx, or SpeedX) and pays for the shipping; the
 * seller gets a prepaid label to print, or a QR code the carrier scans at its counter and prints
 * the label for. Vinted cancels an order the seller hasn't shipped within 5 business days, unless
 * the seller asked the buyer for 3 or 5 more days.
 *
 * Every field here is Listora's model until the read-only mapping (Vinted plan M2) records an
 * order with a label: a value counts only under a field that names it (`SHIPMENT_FIELDS`), and a
 * shipment in no shape Listora knows reads as having no label, never a guess. The buyer is named
 * on Vinted by their member login, so no buyer name is read at all.
 */
import type { LabelReadRequest, RemoteOrderLabel } from '@listora/marketplaces';

import type { VintedTransactionRecord } from './api.ts';
import type { VintedSite } from './common.ts';

/** Vinted's rule: an order not shipped within this many business days cancels itself. */
export const SHIP_WITHIN_BUSINESS_DAYS = 5;

/**
 * The names the fields go by, first match wins. Modeled: Vinted's EU web API names a shipment's
 * tracking number `tracking_code`, the rest is Listora's guess at its US shape.
 */
export const SHIPMENT_FIELDS = {
  shipment: ['shipment', 'shipping_order'],
  tracking: ['tracking_code', 'tracking_number'],
  carrier: ['carrier_name', 'carrier', 'courier_name', 'courier'],
  deadline: ['shipping_deadline', 'ship_by', 'ship_until', 'shipment_deadline'],
  labelExpires: ['label_expires_at', 'label_expiry'],
  labelFormat: ['label_type', 'label_format'],
  labelFile: ['label_url', 'shipping_label_url', 'label_pdf_url'],
  status: ['status'],
} as const;

/** Shipment statuses that say the package left the seller. */
const SHIPPED_STATUSES = new Set(['shipped', 'in_transit', 'delivered', 'completed']);
/** Statuses (the order's or its shipment's) that say the order is canceled or refunded. */
const CANCELED_STATUSES = new Set(['canceled', 'cancelled', 'refunded', 'failed']);
/** The order's statuses that say it is still the seller's to ship. */
const OPEN_ORDER_STATUSES = new Set(['in_progress', 'paid', 'payment_successful']);
/** Shipment formats that are a QR code shown at the counter, not a label to print. */
const QR_FORMATS = new Set(['qr_code', 'qr', 'label_free', 'digital']);
const LABEL_FORMATS = new Set(['label', 'pdf', 'printed', 'printable']);

/** The order's label as its read shows it, for the order Listora asked about. */
export function orderLabel(
  request: LabelReadRequest,
  transaction: VintedTransactionRecord,
  site: VintedSite,
): RemoteOrderLabel {
  const shipment = record(first(transaction, SHIPMENT_FIELDS.shipment));
  const tracking = text(first(shipment, SHIPMENT_FIELDS.tracking));
  const format = labelFormat(text(first(shipment, SHIPMENT_FIELDS.labelFormat)));
  const shownDeadline = time(first(shipment, SHIPMENT_FIELDS.deadline));
  const soldAt = request.soldAt === undefined ? null : time(request.soldAt);
  return {
    externalOrderId: request.externalOrderId,
    found: true,
    trackingNumber: tracking,
    buyerFirstName: null,
    ...orderState(transaction, shipment),
    carrierName: carrierName(first(shipment, SHIPMENT_FIELDS.carrier)),
    // The date Vinted shows (an extension the buyer granted moves it), or else Vinted's rule.
    shipBy:
      shownDeadline ??
      (soldAt === null ? null : addBusinessDays(soldAt, SHIP_WITHIN_BUSINESS_DAYS)),
    labelExpiresAt: time(first(shipment, SHIPMENT_FIELDS.labelExpires)),
    labelFormat: format,
    // A QR code is shown at the counter: nothing to download and print.
    labelFileUrl:
      format === 'qr_code' ? null : labelFile(first(shipment, SHIPMENT_FIELDS.labelFile), site),
  };
}

/**
 * `days` business days after `from`, at the same time of day: Saturdays and Sundays don't count
 * (in UTC). Holidays aren't counted out, so the date is never later than Vinted's own.
 */
export function addBusinessDays(from: Date, days: number): Date {
  const at = new Date(from.getTime());
  let left = days;
  while (left > 0) {
    at.setUTCDate(at.getUTCDate() + 1);
    const weekday = at.getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return at;
}

/**
 * How the order stands, when the read says: canceled (the order's or the shipment's status),
 * shipped (the shipment left the seller, or the order completed), or to ship (an order in
 * progress whose shipment hasn't left). Nothing when it says neither.
 */
function orderState(
  transaction: VintedTransactionRecord,
  shipment: Record<string, unknown> | null,
): { orderState?: 'to_ship' | 'shipped' | 'canceled' } {
  const order = status(first(transaction, SHIPMENT_FIELDS.status));
  const sent = status(first(shipment, SHIPMENT_FIELDS.status));
  if (CANCELED_STATUSES.has(order) || CANCELED_STATUSES.has(sent))
    return { orderState: 'canceled' };
  if (SHIPPED_STATUSES.has(sent) || order === 'completed') return { orderState: 'shipped' };
  if (OPEN_ORDER_STATUSES.has(order)) return { orderState: 'to_ship' };
  return {};
}

function labelFormat(shown: string | null): 'label' | 'qr_code' | null {
  const format = shown?.toLowerCase().replaceAll(/[\s-]+/g, '_') ?? '';
  if (QR_FORMATS.has(format)) return 'qr_code';
  if (LABEL_FORMATS.has(format)) return 'label';
  return null;
}

/** The carrier's name, as a string or as `{ name }` / `{ title }`. */
function carrierName(shown: unknown): string | null {
  const named = record(shown);
  return text(named === null ? shown : (named['name'] ?? named['title'] ?? null));
}

/**
 * The label's file, when it is on Vinted's own site: the phone downloads it through the seller's
 * session, so a file anywhere else is not taken.
 */
function labelFile(shown: unknown, site: VintedSite): string | null {
  const named = text(shown);
  if (named === null || !URL.canParse(named, site.origin)) return null;
  const url = new URL(named, site.origin);
  const onVinted =
    url.origin === site.origin ||
    (url.protocol === 'https:' &&
      (url.hostname === 'vinted.com' || url.hostname.endsWith('.vinted.com')));
  return onVinted ? url.href : null;
}

function first(from: Record<string, unknown> | null, names: readonly string[]): unknown {
  if (from === null) return undefined;
  for (const name of names) {
    const value = from[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function status(value: unknown): string {
  return (
    text(value)
      ?.toLowerCase()
      .replaceAll(/[\s-]+/g, '_') ?? ''
  );
}

/** An ISO time, or a Unix time in seconds; `null` for anything else. */
function time(value: unknown): Date | null {
  const at =
    typeof value === 'number'
      ? new Date(value * 1000)
      : typeof value === 'string' && value.trim() !== ''
        ? new Date(value.trim())
        : null;
  return at === null || Number.isNaN(at.getTime()) ? null : at;
}

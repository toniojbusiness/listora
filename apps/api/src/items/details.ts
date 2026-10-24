/**
 * `ItemDetails` (contract) ↔ `inventory_item` columns, plus the rules the contract states in
 * prose and JSON Schema cannot: UPC/EAN checksums, money that is never negative, a floor price
 * not above the list price, and server-owned field provenance.
 */
import type {
  FieldError,
  ItemDetails,
  KnownProvenance,
  Measurement,
  MeasurementUnit,
  Money,
} from '@listora/api-contract';
import type { InventoryItem, JsonObject } from '@listora/db';

import { canonicalJson } from '../canonical-json.ts';

type DetailKey = keyof ItemDetails;

/**
 * Details as a request gives them. The generated `ItemDetails` marks `quantity` required
 * because it has a default, but a request may leave it out (the server then uses 1).
 */
export type ItemDetailsInput = Omit<ItemDetails, 'quantity'> & { quantity?: number };

/** Text details stored as nullable text columns of the same meaning. */
const TEXT_COLUMNS = {
  title: 'title',
  description: 'description',
  brand: 'brand',
  productName: 'product_name',
  styleNumber: 'style_number',
  rnNumber: 'rn_number',
  upc: 'upc',
  department: 'department',
  category: 'category',
  sizeLabel: 'size_label',
  sizeSystem: 'size_system',
  pattern: 'pattern',
  condition: 'condition',
  conditionNotes: 'condition_notes',
  purchaseDate: 'purchase_date',
  purchaseSource: 'purchase_source',
  storageLocationId: 'storage_location_id',
  acceptedAnalysisId: 'accepted_analysis_id',
} as const satisfies Partial<Record<DetailKey, keyof InventoryItem>>;

/** List details stored as `text[] not null default '{}'`. */
const ARRAY_COLUMNS = {
  colors: 'colors',
  materials: 'materials',
  flaws: 'flaws',
  keywords: 'keywords',
} as const satisfies Partial<Record<DetailKey, keyof InventoryItem>>;

/** Money details stored as integer cents; the item has one `currency` for all of them. */
const MONEY_COLUMNS = {
  listPrice: 'list_price_cents',
  floorPrice: 'floor_price_cents',
  cost: 'cost_cents',
} as const satisfies Partial<Record<DetailKey, keyof InventoryItem>>;

type TextKey = keyof typeof TEXT_COLUMNS;
type ArrayKey = keyof typeof ARRAY_COLUMNS;
type MoneyKey = keyof typeof MONEY_COLUMNS;

/** Every detail. `satisfies` fails the type check when a contract detail is not mapped. */
export const DETAIL_KEYS = Object.keys({
  ...TEXT_COLUMNS,
  ...ARRAY_COLUMNS,
  ...MONEY_COLUMNS,
  measurements: 'measurements',
  quantity: 'quantity',
} satisfies Record<DetailKey, keyof InventoryItem>) as DetailKey[];

/** The quantity an item has when none is given (the contract's default). */
const DEFAULT_QUANTITY = 1;

/** Column values for a full replacement: every detail left out is cleared. */
export interface DetailColumns {
  title: string | null;
  description: string | null;
  brand: string | null;
  product_name: string | null;
  style_number: string | null;
  rn_number: string | null;
  upc: string | null;
  department: string | null;
  category: string | null;
  size_label: string | null;
  size_system: string | null;
  pattern: string | null;
  condition: string | null;
  condition_notes: string | null;
  purchase_date: string | null;
  purchase_source: string | null;
  storage_location_id: string | null;
  accepted_analysis_id: string | null;
  colors: string[];
  materials: string[];
  flaws: string[];
  keywords: string[];
  list_price_cents: number | null;
  floor_price_cents: number | null;
  cost_cents: number | null;
  currency: Money['currency'];
  measurements: JsonObject;
  quantity: number;
}

/**
 * Drops values that mean "no value": empty strings, empty lists (and empty entries in them).
 * Responses omit such properties, so a client that sends back what it read changes nothing.
 * Measurements are put in name order, the order responses use.
 */
export function normalizeDetails(details: ItemDetailsInput | undefined): ItemDetailsInput {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details ?? {}) as [string, unknown][]) {
    if (value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      const entries = (value as unknown[]).filter((entry) => entry !== '');
      if (entries.length > 0) normalized[key] = entries;
      continue;
    }
    normalized[key] = value;
  }
  const measurements = normalized['measurements'] as Measurement[] | undefined;
  if (measurements) normalized['measurements'] = [...measurements].sort(byName);
  return normalized;
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Problems JSON Schema cannot express. `details` must already match the contract schema. */
export function detailErrors(details: ItemDetailsInput): FieldError[] {
  const errors: FieldError[] = [];
  if (details.upc !== undefined && !isValidGtin(details.upc)) {
    errors.push({
      field: 'details.upc',
      message: 'must be 8, 12, 13, or 14 digits with a valid check digit',
    });
  }
  for (const key of Object.keys(MONEY_COLUMNS) as MoneyKey[]) {
    const amount = details[key];
    if (amount !== undefined && amount.amountCents < 0) {
      errors.push({ field: `details.${key}.amountCents`, message: 'must not be negative' });
    }
  }
  const currencies = new Set(
    (Object.keys(MONEY_COLUMNS) as MoneyKey[]).flatMap((key) => details[key]?.currency ?? []),
  );
  if (currencies.size > 1) {
    errors.push({ field: 'details', message: 'every amount must use the same currency' });
  }
  const { listPrice, floorPrice } = details;
  if (listPrice && floorPrice && floorPrice.amountCents > listPrice.amountCents) {
    errors.push({ field: 'details.floorPrice', message: 'must not be above the list price' });
  }
  const seen = new Set<string>();
  details.measurements?.forEach((measurement, index) => {
    if (seen.has(measurement.name)) {
      errors.push({
        field: `details.measurements.${String(index)}.name`,
        message: 'is a duplicate',
      });
    }
    seen.add(measurement.name);
  });
  return errors;
}

/**
 * GS1 check digit (UPC-A, UPC-E as 8 digits, EAN-8, EAN-13, GTIN-14): weights 3 and 1
 * alternate from the digit next to the check digit.
 */
export function isValidGtin(value: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(value)) return false;
  const digits = Array.from(value, (digit) => Number(digit));
  const check = digits.pop();
  const sum = digits
    .reverse()
    .reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return check === (10 - (sum % 10)) % 10;
}

export function columnsFromDetails(details: ItemDetailsInput): DetailColumns {
  const text = (key: TextKey): string | null => details[key] ?? null;
  const list = (key: ArrayKey): string[] => details[key] ?? [];
  const cents = (key: MoneyKey): number | null => details[key]?.amountCents ?? null;
  const currency =
    details.listPrice?.currency ?? details.floorPrice?.currency ?? details.cost?.currency ?? 'USD';
  return {
    title: text('title'),
    description: text('description'),
    brand: text('brand'),
    product_name: text('productName'),
    style_number: text('styleNumber'),
    rn_number: text('rnNumber'),
    upc: text('upc'),
    department: text('department'),
    category: text('category'),
    size_label: text('sizeLabel'),
    size_system: text('sizeSystem'),
    pattern: text('pattern'),
    condition: text('condition'),
    condition_notes: text('conditionNotes'),
    purchase_date: text('purchaseDate'),
    purchase_source: text('purchaseSource'),
    storage_location_id: text('storageLocationId'),
    accepted_analysis_id: text('acceptedAnalysisId'),
    colors: list('colors'),
    materials: list('materials'),
    flaws: list('flaws'),
    keywords: list('keywords'),
    list_price_cents: cents('listPrice'),
    floor_price_cents: cents('floorPrice'),
    cost_cents: cents('cost'),
    currency,
    // Keyed by canonical name (one value per measurement), the shape adapters read.
    measurements: Object.fromEntries(
      (details.measurements ?? []).map(({ name, value, unit }) => [name, { value, unit }]),
    ),
    quantity: details.quantity ?? DEFAULT_QUANTITY,
  };
}

/** The item's details as the contract shows them; a detail with no value is omitted. */
export function detailsFromRow(row: InventoryItem): ItemDetails {
  const details: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(TEXT_COLUMNS)) {
    const value = row[column];
    if (value !== null && value !== '') details[key] = value;
  }
  for (const [key, column] of Object.entries(ARRAY_COLUMNS)) {
    if (row[column].length > 0) details[key] = row[column];
  }
  for (const [key, column] of Object.entries(MONEY_COLUMNS)) {
    const amountCents = row[column];
    if (amountCents !== null) details[key] = { amountCents, currency: row.currency };
  }
  const measurements = Object.entries(row.measurements)
    .map(([name, value]): Measurement => {
      const { value: amount, unit } = value as { value: number; unit: MeasurementUnit };
      return { name, value: amount, unit };
    })
    .sort(byName);
  if (measurements.length > 0) details['measurements'] = measurements;
  details['quantity'] = row.quantity;
  return details as ItemDetails;
}

export type FieldProvenance = Partial<Record<DetailKey, KnownProvenance>>;

/**
 * Server-owned provenance after a write through the API. A detail the request leaves unchanged
 * keeps its source (for example `ocr` or `ai` from an accepted analysis); a detail it sets or
 * changes becomes `user`; a cleared detail has none. A quantity the server fills in by default
 * is not user input, so it has no source.
 */
export function provenanceAfterWrite(
  next: ItemDetailsInput,
  previous: { details: ItemDetails; provenance: FieldProvenance } | undefined,
): FieldProvenance {
  const provenance: FieldProvenance = {};
  for (const key of DETAIL_KEYS) {
    const value = next[key];
    if (value === undefined) continue;
    if (key === 'quantity' && value === DEFAULT_QUANTITY && !previous?.provenance.quantity) {
      continue;
    }
    const before = previous?.details[key];
    if (previous && sameValue(value, before)) {
      const source = previous.provenance[key];
      if (source !== undefined) provenance[key] = source;
    } else {
      provenance[key] = 'user';
    }
  }
  return provenance;
}

/** Details that differ between two versions, as `{ from, to }` (an absent side is omitted). */
export function changedDetails(before: Partial<ItemDetails>, after: ItemDetails): JsonObject {
  const changes: JsonObject = {};
  for (const key of DETAIL_KEYS) {
    if (sameValue(before[key], after[key])) continue;
    changes[key] = {
      ...(before[key] === undefined ? {} : { from: toJson(before[key]) }),
      ...(after[key] === undefined ? {} : { to: toJson(after[key]) }),
    };
  }
  return changes;
}

export function provenanceFromRow(row: InventoryItem): FieldProvenance {
  return row.field_provenance;
}

/** Equal as JSON, whatever the order of object keys (clients may send them in any order). */
function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJson(toJson(a)) === canonicalJson(toJson(b));
}

/** A detail value as plain JSON. */
function toJson(value: unknown): JsonObject[string] {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonObject[string];
}

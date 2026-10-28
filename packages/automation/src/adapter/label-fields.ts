/**
 * Pack check's label reads (docs/features/pack-check.md, "Reading labels") from marketplace data
 * Listora has only seen empty: Poshmark's sales. Their records are read by field names that say
 * what a value is (`tracking_number`, the buyer's `first_name`), at any depth, and nothing else:
 * a value is never taken by its position or its look. A record that names no order id or listing
 * at all is a shape Listora doesn't know, and the page module throws `PageChangedError` for it.
 * Depop's receipts, read on a real shop with sales, are read by their own shape instead
 * (depop/pages/receipts.ts).
 */

/** Every value under a key `keys` names, at any depth (arrays included). */
export function fieldValues(value: unknown, keys: readonly string[], depth = 0): unknown[] {
  if (depth > 6 || typeof value !== 'object' || value === null) return [];
  if (Array.isArray(value)) {
    return (value as unknown[]).flatMap((entry) => fieldValues(entry, keys, depth + 1));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]): unknown[] => [
    ...(keys.includes(key) ? [entry] : []),
    ...fieldValues(entry, keys, depth + 1),
  ]);
}

/** The non-empty strings (and whole numbers, as text) among `values`, without repeats. */
export function texts(values: readonly unknown[]): string[] {
  const found = values.flatMap((value) => {
    if (typeof value === 'string' && value.trim() !== '') return [value.trim()];
    if (typeof value === 'number' && Number.isSafeInteger(value)) return [String(value)];
    return [];
  });
  return [...new Set(found)];
}

/** The tracking number a record names, if any. */
export function trackingField(record: unknown): string | null {
  return texts(fieldValues(record, ['tracking_number', 'trackingNumber']))[0] ?? null;
}

/** The buyer's first name a record names under its `buyer`, if any. */
export function buyerFirstName(record: unknown): string | null {
  if (typeof record !== 'object' || record === null) return null;
  const buyer = (record as Record<string, unknown>)['buyer'];
  return texts(fieldValues(buyer, ['first_name', 'firstName']))[0] ?? null;
}

/**
 * Words dropped from a brand before it is compared: joiners and company suffixes, so
 * "Abercrombie & Fitch" and "Abercrombie" or "Hollister Co." and "Hollister" compare equal.
 */
const IGNORED_WORDS: ReadonlySet<string> = new Set([
  'and',
  'by',
  'co',
  'company',
  'inc',
  'the',
  'outfitter',
]);

/**
 * Leading words too common to name a brand on their own: the key keeps the next word too, so
 * "American Eagle" and "American Apparel", or "Old Navy" and "Old Money", stay apart.
 */
const SHARED_LEADING_WORDS: ReadonlySet<string> = new Set([
  'american',
  'banana',
  'free',
  'j',
  'new',
  'old',
  'polo',
  'true',
  'urban',
]);

/**
 * The key two brands are compared by, or undefined for an empty brand: lowercase, accents and
 * punctuation dropped ("Levi's" and "LEVI" both `levi`), a plural `s` dropped from each word,
 * the ignored words left out, then the first word (two when the first is a shared leading
 * word). It is a match key for the seller's own sales, not a display name.
 */
export function brandKey(brand: string | null | undefined): string | undefined {
  if (brand === null || brand === undefined) return undefined;
  const words = brand
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '')
    .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
    .filter((word) => !IGNORED_WORDS.has(word));
  const [first, second] = words;
  if (first === undefined) return undefined;
  return SHARED_LEADING_WORDS.has(first) && second !== undefined ? `${first} ${second}` : first;
}

/** Shortest brand key a near miss may be snapped from: short names are too easily another brand. */
export const SNAP_MIN_KEY_LENGTH = 5;
/** Most letters a near miss may differ by (inserted, dropped, changed, or two swapped). */
export const SNAP_MAX_EDITS = 2;
/** Most edits for a key's length: 2 in 10 ("Wrenfeld" for "Wrenfield"), 1 in 5 to 9. */
export const SNAP_MAX_EDIT_SHARE = 0.2;

/** A read brand moved to one of the seller's own, and what it was read as. */
export interface SnappedBrand {
  readonly brand: string;
  readonly readAs: string;
}

/**
 * The read brand snapped to the one brand of the seller's own sales it nearly spells
 * (docs/features/thrift-scan.md, "The seller's own sales"): "Wrenfeld" to "Wrenfield" when
 * the seller sold Wrenfield. Undefined, leaving the read as it is, when the read already
 * matches one of them (`brandKey`), its key is shorter than `SNAP_MIN_KEY_LENGTH`, or no brand,
 * or more than one, is within `SNAP_MAX_EDITS` edits and `SNAP_MAX_EDIT_SHARE` of the longer
 * key's length. A different brand of a similar spelling the seller has never sold is left
 * alone, since only the seller's own brands are candidates.
 */
export function snapBrand(
  read: string | null,
  ownBrands: Iterable<string | null>,
): SnappedBrand | undefined {
  const key = brandKey(read);
  if (read === null || key === undefined || key.length < SNAP_MIN_KEY_LENGTH) return undefined;
  // The seller's spelling of each brand: the one written most often.
  const spellings = new Map<string, Map<string, number>>();
  for (const brand of ownBrands) {
    const own = brandKey(brand);
    if (brand === null || own === undefined) continue;
    const counts = spellings.get(own) ?? new Map<string, number>();
    counts.set(brand, (counts.get(brand) ?? 0) + 1);
    spellings.set(own, counts);
  }
  if (spellings.has(key)) return undefined;
  const near = [...spellings.keys()].filter((own) => {
    if (own.length < SNAP_MIN_KEY_LENGTH) return false;
    const allowed = Math.min(
      SNAP_MAX_EDITS,
      Math.floor(Math.max(own.length, key.length) * SNAP_MAX_EDIT_SHARE),
    );
    return allowed > 0 && editDistance(key, own, allowed) <= allowed;
  });
  const [only] = near;
  if (only === undefined || near.length > 1) return undefined;
  const counts = spellings.get(only);
  if (counts === undefined) return undefined;
  const [brand] =
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
  return brand === undefined ? undefined : { brand, readAs: read };
}

/**
 * Edits between two strings (insert, drop, change, or swap two neighbors), or `limit + 1` once
 * it is sure to be more than `limit`.
 */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (before[j - 2] ?? 0) + 1);
      }
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    before = previous;
    previous = current;
  }
  return previous[b.length] ?? limit + 1;
}

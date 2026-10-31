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

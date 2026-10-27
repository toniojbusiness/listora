/**
 * Whether a listing an import read is an item Listora already has (docs/features/imports.md).
 * Pure: the caller loads the candidates (the account's items that are not on this marketplace
 * yet) and the listing's photo hashes.
 *
 * 1. **By its SKU line.** A listing whose text ends with Listora's SKU line names its item (the
 *    SKU is the item's, or another listing of the item carries the same line): that item.
 * 2. **By title and photos.** Otherwise each candidate is scored by how alike the titles are
 *    (the share of words they have in common) and how alike the closest pair of photos is (the
 *    perceptual hashes' Hamming distance). It is the same item only when both say so: a photo
 *    this alike and a title this close, or a nearly identical title and photos that look alike.
 *    One such item is a match.
 * 3. **Ask when unsure.** Two such items, or an item that only one of them points to (the same
 *    photo with another title, the same title with other photos), go to the seller as a
 *    question with the closest few, best first. Never merged without being sure.
 * 4. Otherwise it is a new item.
 */
import { hammingDistance } from '@listora/photos';

/** An item a listing may be. */
export interface MatchCandidate {
  itemId: string;
  sku: string;
  title: string | null;
  brand: string | null;
  /** The SKU lines its listings carry (their `external_sku`). */
  listingSkus: readonly string[];
  /** Its photos' perceptual hashes. */
  photoHashes: readonly string[];
}

/** The listing being imported, as the match reads it. */
export interface MatchListing {
  sku: string | null;
  title: string | null;
  brand: string | null;
  photoHashes: readonly string[];
}

export type MatchReason = 'sku' | 'photo_and_title' | 'title' | 'photo';

export type MatchResult =
  | { type: 'match'; itemId: string; match: 'sku' | 'title_photos' }
  | { type: 'unsure'; candidates: { itemId: string; reason: MatchReason }[] }
  | { type: 'new' };

/** Photos at most this many bits apart are the same photo (re-encoded, resized). */
export const SAME_PHOTO_BITS = 6;
/** Photos at most this many bits apart look alike (another shot of the same item). */
export const ALIKE_PHOTO_BITS = 12;
/** A title sharing this share of its words with the item's names the same thing. */
export const SAME_TITLE = 0.5;
/** Nearly the same title. */
export const NEARLY_SAME_TITLE = 0.8;
/** At most this many items are offered to the seller. */
export const MAX_CANDIDATES = 3;

/** Words that say nothing about which item it is. */
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'of',
  'for',
  'with',
  'in',
  'on',
  'size',
  'sz',
  'new',
  'nwt',
  'nwot',
  'euc',
  'gently',
  'used',
  'womens',
  'women',
  'mens',
  'men',
  'vintage',
]);

export function matchListing(
  listing: MatchListing,
  candidates: readonly MatchCandidate[],
): MatchResult {
  if (listing.sku !== null) {
    const sku = listing.sku.toLowerCase();
    const named = candidates.find(
      (candidate) =>
        candidate.sku.toLowerCase() === sku ||
        candidate.listingSkus.some((line) => line.toLowerCase() === sku),
    );
    if (named !== undefined) return { type: 'match', itemId: named.itemId, match: 'sku' };
  }
  const words = titleWords(listing.title);
  const scored = candidates.flatMap((candidate) => {
    const title = titleSimilarity(words, titleWords(candidate.title));
    const photo = closestPhotos(listing.photoHashes, candidate.photoHashes);
    const brandsDiffer =
      listing.brand !== null &&
      candidate.brand !== null &&
      normalized(listing.brand) !== normalized(candidate.brand);
    const samePhoto = photo !== null && photo <= SAME_PHOTO_BITS;
    const alikePhoto = photo !== null && photo <= ALIKE_PHOTO_BITS;
    const sure =
      !brandsDiffer &&
      ((samePhoto && title >= SAME_TITLE) || (alikePhoto && title >= NEARLY_SAME_TITLE));
    const reason: MatchReason | null = sure
      ? 'photo_and_title'
      : samePhoto || (alikePhoto && title >= SAME_TITLE)
        ? 'photo'
        : title >= NEARLY_SAME_TITLE || (title >= SAME_TITLE && alikePhoto)
          ? 'title'
          : null;
    if (reason === null) return [];
    // Closer photos and titles first.
    const score = title + (photo === null ? 0 : (64 - photo) / 64);
    return [{ itemId: candidate.itemId, sure, reason, score }];
  });
  scored.sort((a, b) => b.score - a.score || a.itemId.localeCompare(b.itemId));
  const sure = scored.filter((candidate) => candidate.sure);
  if (sure.length === 1 && scored.length === 1 && sure[0] !== undefined) {
    return { type: 'match', itemId: sure[0].itemId, match: 'title_photos' };
  }
  if (scored.length === 0) return { type: 'new' };
  return {
    type: 'unsure',
    candidates: scored
      .slice(0, MAX_CANDIDATES)
      .map((candidate) => ({ itemId: candidate.itemId, reason: candidate.reason })),
  };
}

/** A title's words that tell items apart, lowercased, without punctuation or stop words. */
export function titleWords(title: string | null): Set<string> {
  if (title === null) return new Set();
  return new Set(
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/['’]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word)),
  );
}

/**
 * How alike two titles are: the words they share over the words of the shorter one, so a title
 * that adds words to the other ("Levi's 501 jeans" and "Levi's 501 jeans 32x30 dark wash")
 * still reads as the same thing. 0 when either has no words.
 */
export function titleSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/** The Hamming distance of the closest pair of photos; `null` when either has none. */
export function closestPhotos(a: readonly string[], b: readonly string[]): number | null {
  let closest: number | null = null;
  for (const left of a) {
    for (const right of b) {
      const distance = hammingDistance(left, right);
      if (closest === null || distance < closest) closest = distance;
    }
  }
  return closest;
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

import type { AiImage } from '@listora/ai';
import type { Barcode, OcrLine, PhotoRole } from '@listora/api-contract';

/** One photo of the analyzed set, ready to send. */
export interface AnalysisPhoto {
  readonly photoId: string;
  readonly role: PhotoRole;
  /** The photo's `ai` derivative (1024 px). */
  readonly image: AiImage;
  /** A sharper crop of a tag photo's center (`tagCrop` in @listora/photos), when worth it. */
  readonly tagCrop?: AiImage;
  /** What the phone read on it (Vision), uploaded with the photo. */
  readonly ocrLines: readonly OcrLine[];
  readonly barcodes: readonly Barcode[];
}

/** Everything one analysis call needs, independent of where it was loaded from. */
export interface AnalysisInput {
  readonly accountId: string;
  readonly userId: string | null;
  readonly itemId: string | null;
  /**
   * `ai_analysis.photo_set_hash`: over the uploads' sha256s in any order, not over
   * `photos[].image`.
   */
  readonly photoSetHash: string;
  /** In display order; the first is the cover. */
  readonly photos: readonly AnalysisPhoto[];
  /**
   * The seller's own Depop description style (`description_style.depop`); absent means
   * Listora's default, which the system prompt holds.
   */
  readonly depopStyle?: string;
  /**
   * What the thrift scan read from its one shot at the store, when the item was kept from a scan
   * (docs/features/thrift-scan.md, "Upgrading drafts"): a hint the analysis checks against the
   * real photos, as an escalation checks `firstAnalysis`.
   */
  readonly scanRead?: ScanReadHint;
}

/**
 * The identity a thrift scan read, sent with the item's full analysis. Only what the scan saw;
 * never its price guess, so the analysis prices the item from its own photos.
 */
export interface ScanReadHint {
  readonly brand: string | null;
  readonly item: string | null;
  readonly line: string | null;
  readonly styleNumber: string | null;
  readonly era: string | null;
  readonly material: string | null;
  readonly category: string | null;
  readonly department: string | null;
  readonly sizeLabel: string | null;
  readonly condition: string | null;
  readonly identityConfidence: number | null;
  readonly visibleDamage: boolean | null;
}

/**
 * The hint of a stored scan read (`item_scan.read`), field by field: a read stored by an older
 * version, or a field it lacks, gives null rather than failing the analysis. Undefined when
 * the read names nothing at all.
 */
export function scanReadHint(read: unknown): ScanReadHint | undefined {
  if (typeof read !== 'object' || read === null) return undefined;
  const value = read as Record<string, unknown>;
  const text = (key: string): string | null => {
    const field = value[key];
    return typeof field === 'string' && field.trim() !== '' ? field.trim() : null;
  };
  const flags = value['flags'];
  const damage =
    typeof flags === 'object' && flags !== null
      ? (flags as Record<string, unknown>)['visibleDamage']
      : undefined;
  const confidence = value['identityConfidence'];
  const hint: ScanReadHint = {
    brand: text('brand'),
    item: text('item'),
    line: text('line'),
    styleNumber: text('styleNumber'),
    era: text('era'),
    material: text('material'),
    category: text('category'),
    department: text('department'),
    sizeLabel: text('sizeLabel'),
    condition: text('condition'),
    identityConfidence:
      typeof confidence === 'number' && confidence >= 0 && confidence <= 1 ? confidence : null,
    visibleDamage: typeof damage === 'boolean' ? damage : null,
  };
  return Object.values(hint).some((field) => field !== null) ? hint : undefined;
}

/**
 * Photos sent per analysis at most (`selectAnalysisPhotos` picks them): the plan's cost basis
 * is 3-5 `ai` derivatives and one tag crop per call (architecture section 8).
 */
export const MAX_ANALYSIS_PHOTOS = 5;
/** Tag crops sent per analysis, from the first tag photo. */
export const MAX_TAG_CROPS = 1;

/**
 * The photos an analysis sends, in display order: the first `MAX_TAG_CROPS` tag photos
 * wherever they are (their crops are the ones sent), then the others in display order up to
 * `MAX_ANALYSIS_PHOTOS` in all.
 */
export function selectAnalysisPhotos<P extends { readonly role: PhotoRole }>(
  photos: readonly P[],
): P[] {
  const tags = new Set(photos.filter((photo) => photo.role === 'tag').slice(0, MAX_TAG_CROPS));
  const others = new Set(
    photos.filter((photo) => !tags.has(photo)).slice(0, MAX_ANALYSIS_PHOTOS - tags.size),
  );
  return photos.filter((photo) => tags.has(photo) || others.has(photo));
}

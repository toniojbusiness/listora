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
  /** `ai_analysis.photo_set_hash`: over the uploads' sha256s, not over `photos[].image`. */
  readonly photoSetHash: string;
  /** In display order; the first is the cover. */
  readonly photos: readonly AnalysisPhoto[];
}

/** Photos sent per analysis at most (`selectAnalysisPhotos` picks them). */
export const MAX_ANALYSIS_PHOTOS = 8;
/** Tag crops sent per analysis, from the first tag photos. */
export const MAX_TAG_CROPS = 2;

/**
 * The photos an analysis sends, in display order: the first `MAX_TAG_CROPS` tag photos
 * wherever they are, then the others in display order up to `MAX_ANALYSIS_PHOTOS` in all.
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

import type { Barcode, OcrLine, Photo } from '@listora/api-contract';
import type { PhotoTable } from '@listora/db';
import { parsePhotoDerivatives } from '@listora/photos';
import type { ObjectStorage } from '@listora/storage';
import type { Selectable } from 'kysely';

export type PhotoRow = Selectable<PhotoTable>;

/** Turns a photo's public storage keys into URLs (`ObjectStorage.publicUrl`). */
export type PublicUrls = Pick<ObjectStorage, 'publicUrl'>;

/**
 * A photo as the contract shows it. A photo is `processing` until the worker has made its
 * derived images; then it is `ready` with the `urls` of its public ones, or `failed` with the
 * reason.
 */
export function photoFromRow(row: PhotoRow, urls: PublicUrls): Photo {
  // The API stores both when it attaches a file, so a gap here is a bug, not a client error.
  if (row.width === null || row.height === null || row.sha256 === null) {
    throw new Error(`photo ${row.id} has no dimensions or hash`);
  }
  const photo: Photo = {
    id: row.id,
    itemId: row.item_id,
    position: row.position,
    role: row.role,
    status: row.status,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    ocrLines: row.ocr_lines as unknown as OcrLine[],
    barcodes: row.barcodes as unknown as Barcode[],
    createdAt: row.created_at.toISOString(),
  };
  switch (row.status) {
    case 'processing':
      return photo;
    case 'ready': {
      const derivatives = parsePhotoDerivatives(row.derivatives);
      // The database refuses a ready photo without its derivatives.
      if (!derivatives) throw new Error(`ready photo ${row.id} has no derivatives`);
      return {
        ...photo,
        urls: {
          thumbnail: urls.publicUrl(derivatives.thumbnail.key),
          listing: urls.publicUrl(derivatives.listing.key),
        },
      };
    }
    case 'failed':
      return row.failure_reason === null ? photo : { ...photo, failureReason: row.failure_reason };
  }
}

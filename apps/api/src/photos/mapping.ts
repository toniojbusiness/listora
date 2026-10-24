import type { Barcode, OcrLine, Photo } from '@listora/api-contract';
import type { PhotoTable } from '@listora/db';
import type { Selectable } from 'kysely';

export type PhotoRow = Selectable<PhotoTable>;

/**
 * A photo as the contract shows it. Photos stay `processing` until their derived images exist;
 * the image pipeline that makes them (and the `urls` that point at them) is plan task T-07.
 */
export function photoFromRow(row: PhotoRow): Photo {
  // The API stores both when it attaches a file, so a gap here is a bug, not a client error.
  if (row.width === null || row.height === null || row.sha256 === null) {
    throw new Error(`photo ${row.id} has no dimensions or hash`);
  }
  return {
    id: row.id,
    itemId: row.item_id,
    position: row.position,
    role: row.role,
    status: 'processing',
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    ocrLines: row.ocr_lines as unknown as OcrLine[],
    barcodes: row.barcodes as unknown as Barcode[],
    createdAt: row.created_at.toISOString(),
  };
}

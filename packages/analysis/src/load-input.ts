import type { AiImage } from '@listora/ai';
import type { Barcode, OcrLine } from '@listora/api-contract';
import type { DbExecutor } from '@listora/db';
import { parsePhotoDerivatives, tagCrop, type StoredDerivative } from '@listora/photos';
import { photoSetHash } from '@listora/shared';
import type { ObjectStorage } from '@listora/storage';

import { AnalysisFailedError } from './analyze.ts';
import { loadDescriptionStyle } from './description-style.ts';
import {
  MAX_TAG_CROPS,
  selectAnalysisPhotos,
  type AnalysisInput,
  type AnalysisPhoto,
} from './input.ts';
import type { AnalysisRow } from './repository.ts';

/**
 * Loads what an analysis sends from the database and storage: the selected photos' `ai`
 * derivatives, a crop of the first `MAX_TAG_CROPS` tag photos from their `original`, the reads
 * the phone uploaded with each photo, and the seller's own description style. The item's photos
 * must still be the analyzed photo set; anything else fails the analysis with a reason the user
 * can act on.
 */
export async function loadAnalysisInput(
  db: DbExecutor,
  storage: ObjectStorage,
  analysis: AnalysisRow,
): Promise<AnalysisInput> {
  const rows = await db
    .selectFrom('photo')
    .select(['id', 'role', 'status', 'sha256', 'derivatives', 'ocr_lines', 'barcodes'])
    .where('account_id', '=', analysis.account_id)
    .where('item_id', '=', analysis.item_id)
    .orderBy('position')
    .execute();
  const hashes = rows.map((row) => row.sha256);
  if (
    rows.length === 0 ||
    hashes.some((hash) => hash === null) ||
    photoSetHash(hashes as string[]) !== analysis.photo_set_hash
  ) {
    throw fail(
      'photo_set_changed',
      "The item's photos changed after this analysis was requested. Analyze the item again.",
      false,
    );
  }
  if (rows.some((row) => row.status !== 'ready')) {
    throw fail(
      'photos_not_ready',
      'Some photos are still processing or could not be processed. Fix them and analyze again.',
      true,
    );
  }

  const selected = selectAnalysisPhotos(rows);
  const toCrop = new Set(selected.filter((row) => row.role === 'tag').slice(0, MAX_TAG_CROPS));
  const photos = await Promise.all(
    selected.map(async (row): Promise<AnalysisPhoto> => {
      const derivatives = parsePhotoDerivatives(row.derivatives);
      // The database refuses a ready photo without its derivatives.
      if (derivatives === undefined) throw new Error(`ready photo ${row.id} has no derivatives`);
      const image = await loadImage(storage, derivatives.ai);
      let crop: AiImage | undefined;
      if (toCrop.has(row)) {
        const original = await storage.get(derivatives.original.key);
        if (original === undefined) throw missingImage();
        const cropped = await tagCrop(original);
        if (cropped !== undefined) {
          crop = {
            mediaType: 'image/jpeg',
            data: cropped.bytes,
            width: cropped.width,
            height: cropped.height,
          };
        }
      }
      return {
        photoId: row.id,
        role: row.role,
        image,
        ...(crop === undefined ? {} : { tagCrop: crop }),
        ocrLines: row.ocr_lines as unknown as OcrLine[],
        barcodes: row.barcodes as unknown as Barcode[],
      };
    }),
  );
  const style = await loadDescriptionStyle(db, analysis.account_id);
  return {
    accountId: analysis.account_id,
    userId: analysis.requested_by_user_id,
    itemId: analysis.item_id,
    photoSetHash: analysis.photo_set_hash,
    photos,
    ...(style.depop === null ? {} : { depopStyle: style.depop }),
  };
}

async function loadImage(storage: ObjectStorage, derivative: StoredDerivative): Promise<AiImage> {
  const data = await storage.get(derivative.key);
  if (data === undefined) throw missingImage();
  return {
    mediaType: 'image/jpeg',
    data,
    width: derivative.width,
    height: derivative.height,
  };
}

function missingImage(): AnalysisFailedError {
  return fail('photo_missing', "A photo's image is missing. Upload the photo again.", false);
}

function fail(code: string, message: string, retryable: boolean): AnalysisFailedError {
  return new AnalysisFailedError({ code, message, retryable }, { attempts: 0, costMicros: 0 });
}

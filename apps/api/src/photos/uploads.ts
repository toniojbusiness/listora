import type { DbTransaction } from '@listora/db';

import type { Tenant } from '../tenancy.ts';

/** An uploaded file whose bytes arrived and match their declared size and SHA-256. */
export interface UploadedFile {
  storageKey: string;
  sha256: string;
}

export type UploadClaim =
  | { status: 'ready'; file: UploadedFile }
  | { status: 'not_found' | 'incomplete' | 'expired' | 'attached' };

/**
 * Where `addItemPhoto` gets the file it attaches: `SessionPhotoUploads` (upload sessions in
 * uploads/). A `ready` claim has already marked the file attached in the caller's transaction,
 * so it rolls back with the photo; `attached` means another photo already uses the file.
 */
export interface PhotoUploads {
  claim(trx: DbTransaction, tenant: Tenant, uploadFileId: string): Promise<UploadClaim>;
}

import type { DbTransaction } from '@listora/db';

import type { Tenant } from '../tenancy.ts';

/** An uploaded file whose bytes arrived and match their declared size and SHA-256. */
export interface UploadedFile {
  storageKey: string;
  sha256: string;
  /** Pixel size when the server has read it from the file. */
  width?: number;
  height?: number;
}

export type UploadClaim =
  { status: 'ready'; file: UploadedFile } | { status: 'not_found' | 'incomplete' | 'expired' };

/**
 * Where `addItemPhoto` gets the file it attaches. Upload sessions and object storage arrive
 * with plan task T-07, which implements this interface (and marks the file attached in the
 * caller's transaction).
 */
export interface PhotoUploads {
  claim(trx: DbTransaction, tenant: Tenant, uploadFileId: string): Promise<UploadClaim>;
}

/** Until T-07 there are no upload sessions, so no upload file exists. */
export const noPhotoUploads: PhotoUploads = {
  claim: () => Promise.resolve({ status: 'not_found' }),
};

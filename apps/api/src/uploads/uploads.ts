import type { UploadFile, UploadSession } from '@listora/api-contract';
import type { DbExecutor, DbTransaction } from '@listora/db';
import type { ObjectStorage } from '@listora/storage';

import type { PhotoUploads, UploadClaim } from '../photos/uploads.ts';
import type { Tenant } from '../tenancy.ts';
import {
  lockUploadFile,
  markAttached,
  markUploaded,
  type UploadFileRow,
  type UploadSessionRecord,
} from './repository.ts';

/** How long a session's files can be uploaded and attached. */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** How long one upload URL works; `getUploadSession` hands out fresh ones. */
export const UPLOAD_TARGET_TTL_MS = 15 * 60 * 1000;

/**
 * Whether a pending file's bytes are in storage: the object exists, has the declared size,
 * and, when storage reports a checksum, the declared SHA-256. Both drivers already refuse a
 * body that does not match the signed size and checksum; this confirms the upload finished.
 */
export async function isStoredAsDeclared(
  storage: ObjectStorage,
  file: Pick<UploadFileRow, 'storage_key' | 'byte_size' | 'sha256'>,
): Promise<boolean> {
  const stored = await storage.head(file.storage_key);
  return (
    stored?.byteSize === file.byte_size &&
    (stored.sha256 === undefined || stored.sha256 === file.sha256)
  );
}

/** `addItemPhoto` takes its files from upload sessions. */
export class SessionPhotoUploads implements PhotoUploads {
  readonly #storage: ObjectStorage;
  readonly #now: () => Date;

  constructor(storage: ObjectStorage, now: () => Date = () => new Date()) {
    this.#storage = storage;
    this.#now = now;
  }

  async claim(trx: DbTransaction, tenant: Tenant, uploadFileId: string): Promise<UploadClaim> {
    const file = await lockUploadFile(trx, tenant, uploadFileId);
    if (!file) return { status: 'not_found' };
    if (file.status === 'attached') return { status: 'attached' };
    if (file.session_expires_at.getTime() <= this.#now().getTime()) return { status: 'expired' };
    if (file.status === 'pending') {
      if (!(await isStoredAsDeclared(this.#storage, file))) return { status: 'incomplete' };
      await markUploaded(trx, tenant, file.id);
    }
    await markAttached(trx, tenant, file.id);
    return { status: 'ready', file: { storageKey: file.storage_key, sha256: file.sha256 } };
  }
}

/**
 * The session as the contract shows it. With `checkPending`, files still `pending` are checked
 * against storage first (an upload that finished is recorded as `uploaded`). Files still
 * pending get a fresh upload target while the session lasts.
 */
export async function uploadSessionView(
  db: DbExecutor,
  storage: ObjectStorage,
  tenant: Tenant,
  session: UploadSessionRecord,
  options: { now: Date; checkPending: boolean },
): Promise<UploadSession> {
  const { now } = options;
  const live = session.expiresAt.getTime() > now.getTime();
  const targetExpiry = new Date(
    Math.min(now.getTime() + UPLOAD_TARGET_TTL_MS, session.expiresAt.getTime()),
  );
  const files = await Promise.all(
    session.files.map(async (row): Promise<UploadFile> => {
      let status = row.status;
      if (
        status === 'pending' &&
        options.checkPending &&
        (await isStoredAsDeclared(storage, row))
      ) {
        await markUploaded(db, tenant, row.id);
        status = 'uploaded';
      }
      const file: UploadFile = {
        id: row.id,
        status,
        contentType: row.content_type,
        byteSize: row.byte_size,
        sha256: row.sha256,
      };
      if (status !== 'pending' || !live) return file;
      const target = await storage.createUploadTarget({
        key: row.storage_key,
        contentType: row.content_type,
        byteSize: row.byte_size,
        sha256: row.sha256,
        expiresAt: targetExpiry,
      });
      return { ...file, upload: { ...target, expiresAt: target.expiresAt.toISOString() } };
    }),
  );
  return {
    id: session.id,
    expiresAt: session.expiresAt.toISOString(),
    files,
    createdAt: session.createdAt.toISOString(),
  };
}

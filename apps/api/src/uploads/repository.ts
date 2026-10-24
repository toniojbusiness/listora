/**
 * Upload session queries, scoped to the request's `Tenant` like every repository.
 */
import type { DbExecutor, DbTransaction, ImageContentType, UploadFileTable } from '@listora/db';
import { storageKeys } from '@listora/photos';
import type { Selectable } from 'kysely';
import { sql } from 'kysely';

import type { Tenant } from '../tenancy.ts';

export type UploadFileRow = Selectable<UploadFileTable>;

export interface UploadSessionRecord {
  id: string;
  expiresAt: Date;
  createdAt: Date;
  /** In request order. */
  files: UploadFileRow[];
}

export interface NewUploadFile {
  contentType: ImageContentType;
  byteSize: number;
  sha256: string;
}

export async function insertUploadSession(
  trx: DbTransaction,
  tenant: Tenant,
  expiresAt: Date,
  files: readonly NewUploadFile[],
): Promise<UploadSessionRecord> {
  const session = await trx
    .insertInto('upload_session')
    .values({ account_id: tenant.accountId, expires_at: expiresAt })
    .returning(['id', 'expires_at', 'created_at'])
    .executeTakeFirstOrThrow();
  // Ids first, so each file's storage key can name it.
  const { rows: ids } = await sql<{ id: string }>`
    select uuidv7() as id from generate_series(1, ${files.length})
  `.execute(trx);
  const rows = await trx
    .insertInto('upload_file')
    .values(
      files.map((file, position) => {
        const id = ids[position]?.id;
        if (id === undefined) throw new Error('uuidv7() returned too few ids');
        return {
          id,
          account_id: tenant.accountId,
          session_id: session.id,
          position,
          content_type: file.contentType,
          byte_size: file.byteSize,
          sha256: file.sha256,
          storage_key: storageKeys.upload(tenant.accountId, id),
        };
      }),
    )
    .returningAll()
    .execute();
  return {
    id: session.id,
    expiresAt: session.expires_at,
    createdAt: session.created_at,
    files: rows.sort((a, b) => a.position - b.position),
  };
}

export async function findUploadSession(
  db: DbExecutor,
  tenant: Tenant,
  sessionId: string,
): Promise<UploadSessionRecord | undefined> {
  const session = await db
    .selectFrom('upload_session')
    .select(['id', 'expires_at', 'created_at'])
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', sessionId)
    .executeTakeFirst();
  if (!session) return undefined;
  const files = await db
    .selectFrom('upload_file')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('session_id', '=', sessionId)
    .orderBy('position')
    .execute();
  return { id: session.id, expiresAt: session.expires_at, createdAt: session.created_at, files };
}

/** The file and its session's expiry, locked until the caller's transaction ends. */
export async function lockUploadFile(
  trx: DbTransaction,
  tenant: Tenant,
  uploadFileId: string,
): Promise<(UploadFileRow & { session_expires_at: Date }) | undefined> {
  const file = await trx
    .selectFrom('upload_file')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', uploadFileId)
    .forUpdate()
    .executeTakeFirst();
  if (!file) return undefined;
  const session = await trx
    .selectFrom('upload_session')
    .select('expires_at')
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', file.session_id)
    .executeTakeFirstOrThrow();
  return { ...file, session_expires_at: session.expires_at };
}

/** Records that a pending file's bytes are in storage and verified. */
export async function markUploaded(
  db: DbExecutor,
  tenant: Tenant,
  uploadFileId: string,
): Promise<void> {
  await db
    .updateTable('upload_file')
    .set({ status: 'uploaded', uploaded_at: new Date() })
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', uploadFileId)
    .where('status', '=', 'pending')
    .execute();
}

export async function markAttached(
  trx: DbTransaction,
  tenant: Tenant,
  uploadFileId: string,
): Promise<void> {
  await trx
    .updateTable('upload_file')
    .set({ status: 'attached', attached_at: new Date() })
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', uploadFileId)
    .where('status', '=', 'uploaded')
    .execute();
}
